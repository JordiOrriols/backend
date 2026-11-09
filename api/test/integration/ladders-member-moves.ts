import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Isolated Docker database required");

test("Ladders scoped moves retain linked identities, all history and legacy team authorization", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    linked = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID();
  const source = randomUUID(),
    destination = randomUUID(),
    foreign = randomUUID();
  const member = randomUUID(),
    duplicate = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-moves.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const snapshot = async () =>
    (
      await admin.query(
        "SELECT to_jsonb(m)-'team_id'-'updated_at' data FROM public.members m WHERE id=$1",
        [member]
      )
    ).rows[0].data;
  const history = async () =>
    (
      await admin.query(
        `SELECT jsonb_build_object(
      'evaluations',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.evaluations e WHERE member_id=$1),
      'goals',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM public.smart_goals g WHERE member_id=$1),
      'invites',(SELECT jsonb_agg(to_jsonb(i)) FROM public.member_invites i WHERE member_id=$1),
      'vacations',(SELECT jsonb_agg(to_jsonb(v)) FROM public.vacations v WHERE member_id=$1)) data`,
        [member]
      )
    ).rows[0].data;
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, linked]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Move integration'),($2,$3,'Foreign move integration')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$4,$5,'Source'),($2,$4,$5,'Destination'),($3,$4,$6,'Foreign')",
      [source, destination, foreign, owner, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name,planning_role) VALUES($1,$2,'Linked member','backend'),($3,$4,'Duplicate',null)",
      [member, source, duplicate, destination]
    );
    for (const id of [member, duplicate]) {
      await admin.query("SELECT set_config('members.claiming',$1,true)", [id]);
      await admin.query("UPDATE public.members SET user_id=$2 WHERE id=$1", [id, linked]);
    }
    await admin.query(
      "INSERT INTO public.evaluations(member_id,kind,status) VALUES($1,'manager','published'),($1,'self','draft')",
      [member]
    );
    await admin.query(
      "INSERT INTO public.smart_goals(member_id,title) VALUES($1,'Preserved goal')",
      [member]
    );
    await admin.query("INSERT INTO public.member_invites(member_id,created_by) VALUES($1,$2)", [
      member,
      owner,
    ]);
    await admin.query(
      "INSERT INTO public.vacations(member_id,date,is_working) VALUES($1,'2026-11-10',false)",
      [member]
    );
    await admin.query("COMMIT");
    const before = await snapshot(),
      historyBefore = await history();
    await assert.rejects(
      api.laddersMoveMember(account.id, workspace, member, destination),
      /edit access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner'),($1,'ladders',$2,'viewer'),($1,'ladders',$3,'owner')",
      [account.id, workspace, other]
    );
    await assert.rejects(
      api.laddersMoveMember(account.id, workspace, member, destination),
      /edit access/
    );
    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND app='ladders' AND workspace_id=$2",
      [account.id, workspace]
    );
    await assert.rejects(
      api.laddersMoveMember(account.id, workspace, member, foreign),
      /Team unavailable/
    );
    await assert.rejects(
      api.laddersMoveMember(account.id, other, member, foreign),
      /Member unavailable/
    );
    await assert.rejects(
      api.laddersMoveMember(account.id, workspace, randomUUID(), destination),
      /Member unavailable/
    );
    await assert.rejects(
      api.laddersMoveMember(account.id, workspace, member, randomUUID()),
      /Team unavailable/
    );
    await assert.rejects(
      api.pool.query("UPDATE public.members SET team_id=$2 WHERE id=$1", [member, destination]),
      /permission denied/
    );
    await assert.rejects(
      admin.query("UPDATE public.members SET team_id=$2 WHERE id=$1", [member, destination]),
      /both teams require edit access/
    );
    await assert.rejects(
      api.laddersMoveMember(account.id, workspace, member, destination),
      /account already has a member/
    );
    assert.deepEqual(await snapshot(), before);
    await admin.query("DELETE FROM public.members WHERE id=$1", [duplicate]);
    await api.laddersMoveMember(account.id, workspace, member, destination);
    assert.equal(
      (await admin.query("SELECT team_id FROM public.members WHERE id=$1", [member])).rows[0]
        .team_id,
      destination
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await history(), historyBefore);
    const unchanged = (
      await admin.query("SELECT updated_at FROM public.members WHERE id=$1", [member])
    ).rows[0].updated_at;
    await api.laddersMoveMember(account.id, workspace, member, destination);
    assert.deepEqual(
      (await admin.query("SELECT updated_at FROM public.members WHERE id=$1", [member])).rows[0]
        .updated_at,
      unchanged
    );
    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND app='ladders' AND workspace_id=$2",
      [account.id, workspace]
    );
    await api.laddersMoveMember(account.id, workspace, member, source);
    // The ordinary legacy owner can still move members without a platform grant.
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("UPDATE public.members SET team_id=$2 WHERE id=$1", [member, destination]);
    await admin.query("COMMIT");
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.laddersMoveMember(account.id, workspace, member, source),
      /edit access/
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await history(), historyBefore);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.members WHERE id=ANY($1::uuid[])", [[member, duplicate]]);
    await admin.query("DELETE FROM public.teams WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[owner, linked]]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
