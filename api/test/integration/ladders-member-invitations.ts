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

test("exact verified recipients accept one-use member invitations without legacy accounts or workspace grants", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    team = randomUUID(),
    member = randomUUID(),
    second = randomUUID(),
    peerMember = randomUUID(),
    foreign = randomUUID();
  const identity = {
    issuer: "https://member-invite.invalid",
    subject: randomUUID(),
    email: "same@example.invalid",
  };
  const manager = await api.account(identity);
  const recipient = await api.account({ ...identity, subject: randomUUID() });
  const sameEmail = await api.account({ ...identity, subject: randomUUID() });
  const ids = [manager.id, recipient.id, sameEmail.id];
  const manage = (
    action: "get" | "invite" | "revoke" | "unlink",
    target = member,
    account: string | null = recipient.id
  ) => api.laddersMemberInvitationManagement(manager.id, workspace, target, action, account);
  const invitations = () =>
    api.laddersMyMemberInvitations(recipient.id) as Promise<{ id: string; member_id: string }[]>;
  const content = { current_levels: { Technology: 3 }, goal_levels: {}, comments: {} };
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query("INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$2,'Invites')", [
      workspace,
      owner,
    ]);
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$2,$3,'Team')",
      [team, owner, workspace]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name) VALUES($1,$5,'Member'),($2,$5,'Second'),($3,$5,'Peer'),($4,$5,'Foreign')",
      [member, second, peerMember, foreign, team]
    );
    await admin.query("COMMIT");
    await assert.rejects(manage("get"), /edit access/);
    await runPermissionCommand(admin, ["grant", manager.id, "ladders", workspace, "viewer"]);
    for (const action of ["get", "invite", "revoke", "unlink"] as const)
      await assert.rejects(manage(action), /edit access/);
    await runPermissionCommand(admin, ["grant", manager.id, "ladders", workspace, "editor"]);
    await assert.rejects(manage("invite", member, randomUUID()), /first authenticate/);
    await assert.rejects(manage("invite", randomUUID()), /unavailable/);
    assert.deepEqual(await manage("invite"), { linked: false, invited: true });
    const [original] = await invitations();
    assert.ok(original);
    assert.deepEqual(await api.laddersMyMemberInvitations(sameEmail.id), []);
    await assert.rejects(
      api.laddersAnswerMemberInvitation(sameEmail.id, original.id, true),
      /unavailable/
    );
    await manage("invite");
    const [rotated] = await invitations();
    assert.ok(rotated && rotated.id !== original.id);
    await assert.rejects(
      api.laddersAnswerMemberInvitation(recipient.id, original.id, true),
      /unavailable/
    );
    await manage("revoke");
    await assert.rejects(
      api.laddersAnswerMemberInvitation(recipient.id, rotated.id, true),
      /unavailable/
    );
    await manage("invite");
    const [expired] = await invitations();
    assert.ok(expired);
    await admin.query(
      "UPDATE platform.ladders_member_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.id]
    );
    assert.deepEqual(await invitations(), []);
    await assert.rejects(
      api.laddersAnswerMemberInvitation(recipient.id, expired.id, true),
      /unavailable/
    );
    await manage("invite");
    const [declined] = await invitations();
    assert.ok(declined);
    assert.deepEqual(await api.laddersAnswerMemberInvitation(recipient.id, declined.id, false), {
      accepted: false,
      member_id: member,
    });
    await manage("invite");
    const [active] = await invitations();
    assert.ok(active);
    const raced = await Promise.allSettled([
      api.laddersAnswerMemberInvitation(recipient.id, active.id, true),
      api.laddersAnswerMemberInvitation(recipient.id, active.id, true),
    ]);
    assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual(await invitations(), []);
    assert.deepEqual(await manage("get"), { linked: true, invited: false });
    await assert.rejects(manage("invite"), /already linked/);
    const directory = (await api.laddersMyMembers(recipient.id)) as { id: string }[];
    assert.deepEqual(
      directory.map((m) => m.id),
      [member]
    );
    assert.deepEqual(await api.laddersMyMembers(sameEmail.id), []);
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('members.claiming',$1,true)", [foreign]);
    await admin.query("UPDATE public.members SET user_id=$2 WHERE id=$1", [foreign, owner]);
    await admin.query("COMMIT");
    await assert.rejects(
      runPermissionCommand(admin, ["map-legacy", recipient.id, owner]),
      /already linked in a legacy member team/
    );
    assert.equal(
      (await admin.query("SELECT user_id FROM public.members WHERE id=$1", [member])).rows[0]
        .user_id,
      null
    );
    assert.equal(
      (
        await admin.query("SELECT count(*)::int AS n FROM platform.grants WHERE user_id=$1", [
          recipient.id,
        ])
      ).rows[0].n,
      0
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM platform.legacy_account_mappings WHERE user_id=$1",
          [recipient.id]
        )
      ).rows[0].n,
      0
    );
    await assert.rejects(api.laddersMyEvaluations(recipient.id, foreign), /unavailable/);
    await api.laddersSaveMyEvaluation(recipient.id, member, null, content);
    const goal = (await api.laddersSaveGoal(manager.id, workspace, member, null, {
      title: "Direct account goal",
      description: "",
      due_date: null,
      progress: 0,
    })) as { id: string };
    await api.laddersUpdateMyGoal(recipient.id, member, goal.id, 40, null);
    await api.laddersUpdateMyGoal(recipient.id, member, goal.id, null, "Progress note");
    const goals = (await api.laddersMyGoals(recipient.id, member)) as {
      id: string;
      progress: number;
    }[];
    assert.equal(goals[0]?.progress, 40);
    await manage("invite", second);
    const [duplicate] = await invitations();
    assert.ok(duplicate);
    await assert.rejects(
      api.laddersAnswerMemberInvitation(recipient.id, duplicate.id, true),
      /already linked to a member/
    );
    const otherTeam = randomUUID();
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$2,$3,'Second team')",
      [otherTeam, owner, workspace]
    );
    await admin.query("COMMIT");
    await api.laddersMoveMember(manager.id, workspace, second, otherTeam);
    await api.laddersAnswerMemberInvitation(recipient.id, duplicate.id, true);
    await assert.rejects(
      api.laddersMoveMember(manager.id, workspace, second, team),
      /already linked in the destination team/
    );
    await manage("unlink", second);
    await api.laddersMoveMember(manager.id, workspace, second, team);
    await admin.query("DELETE FROM public.teams WHERE id=$1", [otherTeam]);
    await manage("invite", peerMember, sameEmail.id);
    const [peerInvite] = (await api.laddersMyMemberInvitations(sameEmail.id)) as { id: string }[];
    assert.ok(peerInvite);
    await api.laddersAnswerMemberInvitation(sameEmail.id, peerInvite.id, true);
    const candidates = (await api.laddersPeerManagement(
      manager.id,
      workspace,
      member,
      "candidates"
    )) as { id: string }[];
    assert.deepEqual(
      candidates.map((m) => m.id),
      [peerMember]
    );
    const [assignment] = (await api.laddersPeerManagement(
      manager.id,
      workspace,
      member,
      "assign",
      peerMember
    )) as { id: string }[];
    assert.ok(assignment);
    await api.laddersSubmitPeer(sameEmail.id, assignment.id, content);
    assert.deepEqual(await manage("unlink", peerMember), { linked: false, invited: false });
    assert.deepEqual(await api.laddersMyPeerAssignments(sameEmail.id), []);
    await assert.rejects(
      api.laddersSubmitPeer(sameEmail.id, assignment.id, content),
      /unavailable/
    );
    await manage("unlink");
    assert.deepEqual(await api.laddersMyMembers(recipient.id), []);
    await assert.rejects(
      api.laddersSaveMyEvaluation(recipient.id, member, null, content),
      /unavailable/
    );
    await assert.rejects(
      api.laddersUpdateMyGoal(recipient.id, member, goal.id, 100, null),
      /unavailable/
    );
    const denied = await admin.query<{ denied: boolean }>(
      `SELECT NOT has_table_privilege(r, 'platform.ladders_member_links', 'SELECT')
        AND NOT has_table_privilege(r, 'platform.ladders_member_invitations', 'SELECT')
        AND NOT has_function_privilege(r, 'platform.ladders_member_account(uuid)', 'EXECUTE') AS denied
       FROM unnest(ARRAY['anon','authenticated','service_role','platform_api']) r`
    );
    assert.ok(denied.rows.every((row) => row.denied));
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM public.evaluations WHERE member_id=ANY($1::uuid[])", [
      [member, second, peerMember, foreign],
    ]);
    await admin.query(
      "DELETE FROM public.members WHERE team_id IN (SELECT id FROM public.teams WHERE workspace_id=$1)",
      [workspace]
    );
    await admin.query("DELETE FROM public.teams WHERE workspace_id=$1", [workspace]);
    await admin.query("DELETE FROM public.workspaces WHERE id=$1", [workspace]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [ids]);
    await Promise.all([admin.end(), api.pool.end()]);
  }
});
