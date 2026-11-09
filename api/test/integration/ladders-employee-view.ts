import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import {
  localPermissionConnection,
  runPermissionCommand,
} from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Isolated Docker database required");

test("employee evaluations require explicit mapping and member ownership, redact reviewer comments and exclude private reviewer drafts", async () => {
  const admin = new Client({ connectionString: adminURL });
  const restricted = new Client({ connectionString: apiURL });
  const api = new PlatformDatabase(apiURL);
  await Promise.all([admin.connect(), restricted.connect()]);
  const legacy = randomUUID(),
    workspace = randomUUID(),
    team = randomUUID(),
    member = randomUUID(),
    foreignMember = randomUUID();
  const identity = {
    issuer: "https://employee-view.invalid",
    subject: randomUUID(),
    email: "employee-view@example.invalid",
  };
  const employee = await api.account(identity);
  const sameEmail = await api.account({ ...identity, subject: randomUUID() });
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [legacy]);
    await admin.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [legacy, identity.email]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$2,'Employee workspace')",
      [workspace, legacy]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$2,$3,'Employee team')",
      [team, legacy, workspace]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name) VALUES($1,$3,'Own member'),($2,$3,'Other member')",
      [member, foreignMember, team]
    );
    await admin.query("SELECT set_config('members.claiming',$1,true)", [member]);
    await admin.query("UPDATE public.members SET user_id=$2 WHERE id=$1", [member, legacy]);
    const fixtures = [
      { kind: "manager", status: "draft", author: "Private manager", comments: {} },
      { kind: "peer", status: "draft", author: "Private peer", comments: {} },
      { kind: "self", status: "draft", author: null, comments: { Technology: "Own draft" } },
      { kind: "self", status: "published", author: null, comments: {} },
      {
        kind: "manager",
        status: "published",
        author: "Manager",
        comments: { Technology: "Visible manager", System: "Hidden manager" },
      },
      {
        kind: "peer",
        status: "published",
        author: "Peer",
        comments: { Technology: "Visible peer", System: "Hidden peer" },
      },
    ];
    for (const fixture of fixtures)
      await admin.query(
        `INSERT INTO public.evaluations(member_id,kind,status,author_name,comments,comment_visibility)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          member,
          fixture.kind,
          fixture.status,
          fixture.author,
          fixture.comments,
          fixture.kind === "manager"
            ? { System: false }
            : fixture.kind === "peer"
              ? { Technology: true }
              : {},
        ]
      );
    await admin.query("COMMIT");
    assert.deepEqual(await api.laddersMyMembers(employee.id), []);
    await assert.rejects(api.laddersMyEvaluations(employee.id, member), /unavailable/);
    await runPermissionCommand(admin, ["map-legacy", employee.id, legacy]);
    const profile = {
      id: member,
      name: "Own member",
      role: "",
      planning_role: null,
      template_id: null,
      workspace_id: workspace,
      workspace_name: "Employee workspace",
    };
    assert.deepEqual(await api.laddersMyMembers(employee.id), [profile]);
    assert.deepEqual(await api.laddersMyMembers(sameEmail.id), []);
    await assert.rejects(api.laddersMyEvaluations(sameEmail.id, member), /unavailable/);
    await assert.rejects(api.laddersMyEvaluations(employee.id, foreignMember), /unavailable/);
    await assert.rejects(api.laddersTeams(employee.id, workspace), /access required/i);
    const result = await restricted.query<{
      data: { member: typeof profile; evaluations: Record<string, unknown>[] };
    }>("SELECT platform.ladders_my_evaluations($1,$2) AS data", [employee.id, member]);
    const snapshot = result.rows[0]!.data;
    assert.deepEqual(await api.laddersMyEvaluations(employee.id, member), snapshot);
    assert.deepEqual(snapshot.member, profile);
    assert.equal(snapshot.evaluations.length, 4);
    for (const evaluation of snapshot.evaluations) {
      assert.deepEqual(Object.keys(evaluation).sort(), [
        "author_name",
        "comment_visibility",
        "comments",
        "created_at",
        "current_levels",
        "goal_levels",
        "id",
        "kind",
        "member_id",
        "status",
      ]);
      assert.deepEqual(evaluation.comment_visibility, {});
      if (evaluation.kind === "manager")
        assert.deepEqual(evaluation.comments, { Technology: "Visible manager" });
      if (evaluation.kind === "peer")
        assert.deepEqual(evaluation.comments, { Technology: "Visible peer" });
    }
    const json = JSON.stringify(snapshot);
    for (const secret of [
      "Hidden manager",
      "Hidden peer",
      "Private manager",
      "Private peer",
      legacy,
    ])
      assert.ok(!json.includes(secret));
    assert.ok(json.includes("Own draft"));
    await runPermissionCommand(admin, ["grant", sameEmail.id, "ladders", workspace, "owner"]);
    assert.deepEqual(await api.laddersMyMembers(sameEmail.id), []);
    await assert.rejects(api.laddersMyEvaluations(sameEmail.id, member), /unavailable/);
    await assert.rejects(restricted.query("SELECT * FROM public.members"), /permission denied/);
    const roles = await admin.query<{ denied: boolean }>(
      `SELECT NOT has_function_privilege(r, 'platform.ladders_my_members(uuid)', 'EXECUTE')
        AND NOT has_function_privilege(r, 'platform.ladders_my_evaluations(uuid,uuid)', 'EXECUTE') AS denied
       FROM unnest(ARRAY['anon','authenticated','service_role']) r`
    );
    assert.ok(roles.rows.every((row) => row.denied));
    const selfSnapshot = await api.laddersMySelfEvaluations(employee.id, member);
    const selfVersions = snapshot.evaluations.filter((row) => row.kind === "self");
    assert.deepEqual(selfSnapshot, { member: profile, evaluations: selfVersions });
    const draft = selfVersions.find((row) => row.status === "draft")!;
    const reviewer = snapshot.evaluations.find((row) => row.kind === "manager")!;
    assert.equal(typeof draft.id, "string");
    const draftId = String(draft.id);
    const content = {
      current_levels: { Technology: 3.5 },
      goal_levels: {},
      comments: { Technology: "Updated own draft" },
    };
    const reviewerBefore = await admin.query(
      "SELECT to_jsonb(e) AS data FROM public.evaluations e WHERE id=$1",
      [reviewer.id]
    );
    await assert.rejects(api.laddersMySelfEvaluations(sameEmail.id, member), /unavailable/);
    await assert.rejects(
      api.laddersSaveMyEvaluation(sameEmail.id, member, draftId, content),
      /unavailable/
    );
    await assert.rejects(
      api.laddersSaveMyEvaluation(employee.id, foreignMember, draftId, content),
      /unavailable/
    );
    await assert.rejects(
      api.laddersSaveMyEvaluation(employee.id, member, String(reviewer.id), content),
      /unavailable/
    );
    await assert.rejects(
      api.laddersPublishMyEvaluation(employee.id, member, String(reviewer.id)),
      /unavailable/
    );
    await assert.rejects(
      api.laddersSaveMyEvaluation(employee.id, member, null, content),
      /already exists/
    );
    await assert.rejects(
      api.laddersSaveMyEvaluation(employee.id, member, draftId, {
        ...content,
        current_levels: { Technology: 6 },
      }),
      /Invalid evaluation content/
    );
    assert.deepEqual(await api.laddersSaveMyEvaluation(employee.id, member, draftId, content), {
      ...draft,
      ...content,
    });
    assert.deepEqual(await api.laddersPublishMyEvaluation(employee.id, member, draftId), {
      ...draft,
      ...content,
      status: "published",
    });
    await assert.rejects(
      api.laddersSaveMyEvaluation(employee.id, member, draftId, content),
      /immutable/
    );
    const attempts = await Promise.allSettled([
      api.laddersSaveMyEvaluation(employee.id, member, null, content),
      api.laddersSaveMyEvaluation(employee.id, member, null, content),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    const newDraft = await admin.query<{
      id: string;
      author_name: string;
      comment_visibility: unknown;
    }>(
      "SELECT id,author_name,comment_visibility FROM public.evaluations WHERE member_id=$1 AND kind='self' AND status='draft'",
      [member]
    );
    assert.equal(newDraft.rows.length, 1);
    assert.equal(newDraft.rows[0]!.author_name, profile.name);
    assert.deepEqual(newDraft.rows[0]!.comment_visibility, {});
    await admin.query(
      "UPDATE public.evaluations SET comment_visibility='{\"Technology\":false}' WHERE id=$1",
      [draftId]
    );
    assert.ok(
      JSON.stringify(await api.laddersMySelfEvaluations(employee.id, member)).includes(
        "Updated own draft"
      )
    );
    const redacted = await restricted.query<{ data: { evaluations: Record<string, unknown>[] } }>(
      "SELECT platform.ladders_my_evaluations($1,$2) AS data",
      [employee.id, member]
    );
    assert.deepEqual(
      redacted.rows[0]!.data.evaluations.find((row) => row.id === draftId)?.comments,
      {}
    );
    assert.deepEqual(
      await admin
        .query("SELECT to_jsonb(e) AS data FROM public.evaluations e WHERE id=$1", [reviewer.id])
        .then((result) => result.rows),
      reviewerBefore.rows
    );
    const writeRoles = await admin.query<{ denied: boolean }>(
      `SELECT NOT has_function_privilege(r, 'platform.ladders_save_my_evaluation(uuid,uuid,uuid,jsonb)', 'EXECUTE')
        AND NOT has_function_privilege(r, 'platform.ladders_publish_my_evaluation(uuid,uuid,uuid)', 'EXECUTE')
        AND NOT has_function_privilege(r, 'platform.ladders_my_self_evaluations(uuid,uuid)', 'EXECUTE') AS denied
       FROM unnest(ARRAY['anon','authenticated','service_role']) r`
    );
    assert.ok(writeRoles.rows.every((row) => row.denied));
    await assert.rejects(
      restricted.query("SELECT platform.ladders_lock_my_member($1,$2)", [employee.id, member]),
      /permission denied/
    );
    const goal = randomUUID(),
      foreignGoal = randomUUID();
    const legacyNote = {
      id: randomUUID(),
      text: "Legacy note",
      createdAt: "2026-10-01T00:00:00Z",
      authorKind: "legacy",
    };
    await admin.query(
      `INSERT INTO public.smart_goals(id,member_id,title,description,due_date,comments) VALUES
      ($1,$2,'Manager goal','Definition','2026-12-01',$5),
      ($3,$4,'Other goal','Other definition',null,'[]')`,
      [goal, member, foreignGoal, foreignMember, JSON.stringify([legacyNote])]
    );
    const goalBefore = await admin.query<{ data: Record<string, unknown> }>(
      "SELECT to_jsonb(g)-'updated_at'-'progress'-'comments' AS data FROM public.smart_goals g WHERE id=$1",
      [goal]
    );
    const ownGoals = await api.laddersMyGoals(employee.id, member);
    assert.ok(Array.isArray(ownGoals) && ownGoals.length === 1);
    assert.equal(ownGoals[0].id, goal);
    await assert.rejects(api.laddersMyGoals(sameEmail.id, member), /unavailable/);
    await assert.rejects(api.laddersMyGoals(employee.id, foreignMember), /unavailable/);
    await assert.rejects(
      api.laddersUpdateMyGoal(employee.id, member, foreignGoal, 50, null),
      /unavailable/
    );
    await assert.rejects(
      api.laddersUpdateMyGoal(sameEmail.id, member, goal, 50, null),
      /unavailable/
    );
    for (const progress of [-1, 101])
      await assert.rejects(
        api.laddersUpdateMyGoal(employee.id, member, goal, progress, null),
        /Invalid goal/
      );
    for (const comment of ["", " ", "x".repeat(10001)])
      await assert.rejects(
        api.laddersUpdateMyGoal(employee.id, member, goal, null, comment),
        /Invalid goal/
      );
    await assert.rejects(
      api.laddersUpdateMyGoal(employee.id, member, goal, null, null),
      /Invalid goal/
    );
    await assert.rejects(
      api.laddersUpdateMyGoal(employee.id, member, goal, 20, "two updates"),
      /Invalid goal/
    );
    await api.laddersUpdateMyGoal(employee.id, member, goal, 70, null);
    await Promise.all([
      api.laddersUpdateMyGoal(employee.id, member, goal, null, " Employee note one "),
      api.laddersUpdateMyGoal(employee.id, member, goal, null, "Employee note two"),
    ]);
    const goalAfter = await admin.query<{
      progress: number;
      comments: { text: string; authorKind?: string }[];
      data: unknown;
    }>(
      "SELECT progress,comments,to_jsonb(g)-'updated_at'-'progress'-'comments' AS data FROM public.smart_goals g WHERE id=$1",
      [goal]
    );
    assert.equal(goalAfter.rows[0]!.progress, 70);
    assert.deepEqual(goalAfter.rows[0]!.data, goalBefore.rows[0]!.data);
    assert.deepEqual(goalAfter.rows[0]!.comments[0], legacyNote);
    assert.deepEqual(
      goalAfter.rows[0]!.comments.slice(1)
        .map((comment) => comment.text)
        .sort(),
      ["Employee note one", "Employee note two"]
    );
    assert.ok(
      goalAfter.rows[0]!.comments.slice(1).every((comment) => comment.authorKind === "member")
    );
    const goalRoles = await admin.query<{ denied: boolean }>(
      `SELECT NOT has_function_privilege(r, 'platform.ladders_my_goals(uuid,uuid)', 'EXECUTE')
        AND NOT has_function_privilege(r, 'platform.ladders_update_my_goal(uuid,uuid,uuid,smallint,text)', 'EXECUTE') AS denied
       FROM unnest(ARRAY['anon','authenticated','service_role']) r`
    );
    assert.ok(goalRoles.rows.every((row) => row.denied));
    await runPermissionCommand(admin, ["unmap-legacy", employee.id, legacy]);
    assert.deepEqual(await api.laddersMyMembers(employee.id), []);
    await assert.rejects(api.laddersMyEvaluations(employee.id, member), /unavailable/);
    assert.deepEqual((await api.account(identity)).grants, []);
    await assert.rejects(api.laddersMySelfEvaluations(employee.id, member), /unavailable/);
    await assert.rejects(
      api.laddersSaveMyEvaluation(employee.id, member, newDraft.rows[0]!.id, content),
      /unavailable/
    );
    await assert.rejects(
      api.laddersPublishMyEvaluation(employee.id, member, newDraft.rows[0]!.id),
      /unavailable/
    );
    await assert.rejects(api.laddersMyGoals(employee.id, member), /unavailable/);
    await assert.rejects(
      api.laddersUpdateMyGoal(employee.id, member, goal, 100, null),
      /unavailable/
    );
    await assert.rejects(
      api.laddersUpdateMyGoal(employee.id, member, goal, null, "Revoked"),
      /unavailable/
    );
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.legacy_account_mappings WHERE legacy_user_id=$1", [
      legacy,
    ]);
    await admin.query("DELETE FROM platform.grants WHERE workspace_id=$1", [workspace]);
    await admin.query("DELETE FROM public.members WHERE team_id=$1", [team]);
    await admin.query("DELETE FROM public.teams WHERE workspace_id=$1", [workspace]);
    await admin.query("DELETE FROM public.workspaces WHERE id=$1", [workspace]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [legacy]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [
      [employee.id, sameEmail.id],
    ]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [
      [employee.id, sameEmail.id],
    ]);
    await Promise.all([admin.end(), restricted.end(), api.pool.end()]);
  }
});
