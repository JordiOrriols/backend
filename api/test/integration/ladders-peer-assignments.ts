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

test("peer assignments use verified mapped colleagues, scope reviewer access and accept one draft submission for manager moderation", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    reviewerLegacy = randomUUID(),
    workspace = randomUUID(),
    team = randomUUID(),
    member = randomUUID(),
    reviewerMember = randomUUID(),
    unlinked = randomUUID();
  const identity = {
    issuer: "https://peer-test.invalid",
    subject: randomUUID(),
    email: "peers@example.invalid",
  };
  const manager = await api.account(identity);
  const reviewer = await api.account({ ...identity, subject: randomUUID() });
  const sameEmail = await api.account({ ...identity, subject: randomUUID() });
  type Assignment = { id: string; name: string; submitted: boolean; revoked: boolean };
  const manage = (
    action: "list" | "candidates" | "assign" | "revoke",
    target: string | null = null
  ) =>
    api.laddersPeerManagement(manager.id, workspace, member, action, target) as Promise<
      Assignment[]
    >;
  const content = {
    current_levels: { Technology: 3.5 },
    goal_levels: { Technology: 5 },
    comments: { Technology: "Peer feedback" },
  };
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, reviewerLegacy]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$2,'Peer workspace')",
      [workspace, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$2,$3,'Peer team')",
      [team, owner, workspace]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name) VALUES($1,$4,'Target'),($2,$4,'Verified reviewer'),($3,$4,'Unlinked')",
      [member, reviewerMember, unlinked, team]
    );
    await admin.query("SELECT set_config('members.claiming',$1,true)", [reviewerMember]);
    await admin.query("UPDATE public.members SET user_id=$2 WHERE id=$1", [
      reviewerMember,
      reviewerLegacy,
    ]);
    await admin.query("COMMIT");
    await runPermissionCommand(admin, ["map-legacy", reviewer.id, reviewerLegacy]);
    await assert.rejects(manage("list"), /edit access/);
    await runPermissionCommand(admin, ["grant", manager.id, "ladders", workspace, "viewer"]);
    await assert.rejects(manage("candidates"), /edit access/);
    await assert.rejects(manage("assign", reviewerMember), /edit access/);
    await runPermissionCommand(admin, ["grant", manager.id, "ladders", workspace, "editor"]);
    assert.deepEqual(await manage("candidates"), [
      { id: reviewerMember, name: "Verified reviewer" },
    ]);
    for (const id of [member, unlinked, randomUUID()])
      await assert.rejects(manage("assign", id), /unavailable/);
    const [assignment] = await manage("assign", reviewerMember);
    assert.ok(assignment);
    await assert.rejects(
      api.laddersPeerManagement(manager.id, workspace, unlinked, "revoke", assignment.id),
      /unavailable/
    );
    await assert.rejects(
      api.laddersPeerManagement(manager.id, randomUUID(), member, "list"),
      /edit access/
    );
    await assert.rejects(manage("assign", reviewerMember), /already pending/);
    assert.deepEqual(await api.laddersMyPeerAssignments(sameEmail.id), []);
    assert.deepEqual(await api.laddersMyPeerAssignments(manager.id), []);
    await assert.rejects(
      api.laddersSubmitPeer(reviewer.id, assignment.id, {
        ...content,
        current_levels: { Technology: 6 },
      }),
      /Invalid evaluation content/
    );
    assert.deepEqual(await api.laddersMyPeerAssignments(reviewer.id), [
      {
        id: assignment.id,
        member_id: member,
        name: "Target",
        role: "",
        template_id: null,
        submitted: false,
      },
    ]);
    await assert.rejects(api.laddersTeams(reviewer.id, workspace), /access required/);
    await assert.rejects(api.laddersMyEvaluations(reviewer.id, member), /unavailable/);
    await assert.rejects(
      api.laddersSubmitPeer(sameEmail.id, assignment.id, content),
      /unavailable/
    );
    await assert.rejects(api.laddersSubmitPeer(manager.id, assignment.id, content), /unavailable/);
    const attempts = await Promise.allSettled([
      api.laddersSubmitPeer(reviewer.id, assignment.id, content),
      api.laddersSubmitPeer(reviewer.id, assignment.id, content),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const saved = attempts.find((attempt) => attempt.status === "fulfilled");
    assert.ok(saved && saved.status === "fulfilled");
    const submitted = saved.value as Record<string, unknown>;
    assert.equal(submitted.kind, "peer");
    assert.equal(submitted.status, "draft");
    assert.equal(submitted.author_name, "Verified reviewer");
    assert.deepEqual(submitted.comment_visibility, {});
    assert.deepEqual(submitted.goal_levels, {});
    assert.deepEqual(submitted.comments, content.comments);
    await api.laddersEvaluationStatus(
      manager.id,
      workspace,
      member,
      String(submitted.id),
      "published"
    );
    await manage("revoke", assignment.id);
    assert.deepEqual(await api.laddersMyPeerAssignments(reviewer.id), []);
    const [next] = (await manage("assign", reviewerMember)).filter(
      (row) => row.id !== assignment.id
    );
    assert.ok(next);
    await runPermissionCommand(admin, ["unmap-legacy", reviewer.id, reviewerLegacy]);
    assert.deepEqual(await api.laddersMyPeerAssignments(reviewer.id), []);
    await assert.rejects(api.laddersSubmitPeer(reviewer.id, next.id, content), /unavailable/);
    await runPermissionCommand(admin, ["map-legacy", reviewer.id, reviewerLegacy]);
    await manage("revoke", next.id);
    await assert.rejects(api.laddersSubmitPeer(reviewer.id, next.id, content), /unavailable/);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM public.evaluations WHERE member_id=$1",
          [member]
        )
      ).rows[0].count,
      1
    );
    await assert.rejects(
      api.pool.query("SELECT * FROM platform.ladders_peer_assignments"),
      /permission denied/
    );
    const roles = await admin.query<{ denied: boolean }>(
      `SELECT NOT has_function_privilege(r, 'platform.ladders_my_peer_assignments(uuid)', 'EXECUTE')
        AND NOT has_function_privilege(r, 'platform.ladders_submit_peer(uuid,uuid,jsonb)', 'EXECUTE')
        AND NOT has_table_privilege(r, 'platform.ladders_peer_assignments', 'SELECT') AS denied
       FROM unnest(ARRAY['anon','authenticated','service_role']) r`
    );
    assert.ok(roles.rows.every((row) => row.denied));
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.legacy_account_mappings WHERE legacy_user_id=$1", [
      reviewerLegacy,
    ]);
    await admin.query("DELETE FROM platform.grants WHERE workspace_id=$1", [workspace]);
    await admin.query("DELETE FROM public.members WHERE team_id=$1", [team]);
    await admin.query("DELETE FROM public.teams WHERE id=$1", [team]);
    await admin.query("DELETE FROM public.workspaces WHERE id=$1", [workspace]);
    await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[owner, reviewerLegacy]]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [
      [manager.id, reviewer.id, sameEmail.id],
    ]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [
      [manager.id, reviewer.id, sameEmail.id],
    ]);
    await Promise.all([admin.end(), api.pool.end()]);
  }
});
