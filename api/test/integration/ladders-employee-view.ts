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
    await runPermissionCommand(admin, ["unmap-legacy", employee.id, legacy]);
    assert.deepEqual(await api.laddersMyMembers(employee.id), []);
    await assert.rejects(api.laddersMyEvaluations(employee.id, member), /unavailable/);
    assert.deepEqual((await api.account(identity)).grants, []);
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
