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
test("Ladders owner deletion preserves team/workspace protections and cascades only target member records", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    team = randomUUID(),
    defaultTeam = randomUUID();
  const member = randomUUID(),
    survivor = randomUUID(),
    goal = randomUUID(),
    application = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-deletion.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name,created_for_team) VALUES($1,$3,'Deletion integration',true),($2,$3,'Other deletion integration',false)",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name,is_default) VALUES($1,$3,$4,'Delete team',false),($2,$3,$4,'Default team',true)",
      [team, defaultTeam, owner, workspace]
    );
    await admin.query(
      "INSERT INTO public.members(id,owner_id,team_id,name) VALUES($1,$3,$4,'Target'),($2,$3,$5,'Survivor')",
      [member, survivor, owner, team, defaultTeam]
    );
    await admin.query(
      "INSERT INTO public.evaluations(member_id,kind,status) VALUES($1,'manager','published'),($2,'manager','published')",
      [member, survivor]
    );
    await admin.query("INSERT INTO public.smart_goals(id,member_id,title) VALUES($1,$2,'Goal')", [
      goal,
      member,
    ]);
    await admin.query("INSERT INTO public.member_invites(member_id,created_by) VALUES($1,$2)", [
      member,
      owner,
    ]);
    await admin.query(
      "INSERT INTO public.vacations(member_id,date,is_working) VALUES($1,'2026-11-09',false)",
      [member]
    );
    await admin.query(
      "INSERT INTO public.shiplog_applications(id,workspace_id,team_id,name) VALUES($1,$2,$3,'Linked app')",
      [application, workspace, team]
    );
    await admin.query("COMMIT");
    await assert.rejects(api.laddersDeleteMember(account.id, workspace, member), /owner access/);
    await assert.rejects(api.laddersDeleteTeam(account.id, workspace, team), /owner access/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner'),($1,'ladders',$2,'editor')",
      [account.id, workspace]
    );
    await assert.rejects(api.laddersDeleteMember(account.id, workspace, member), /owner access/);
    await assert.rejects(api.laddersDeleteTeam(account.id, workspace, team), /owner access/);
    await admin.query(
      "UPDATE platform.grants SET role='viewer' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await assert.rejects(api.laddersDeleteMember(account.id, workspace, member), /owner access/);
    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await assert.rejects(api.laddersDeleteTeam(account.id, workspace, team), /team is not empty/);
    await assert.rejects(api.laddersDeleteTeam(account.id, workspace, defaultTeam), /default team/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'owner')",
      [account.id, other]
    );
    await assert.rejects(api.laddersDeleteMember(account.id, other, member), /Member unavailable/);
    await assert.rejects(api.laddersDeleteTeam(account.id, other, team), /Team unavailable/);
    await api.laddersDeleteMember(account.id, workspace, member);
    for (const table of ["evaluations", "smart_goals", "member_invites", "vacations"]) {
      assert.equal(
        (
          await admin.query(
            `SELECT count(*)::int AS count FROM public.${table} WHERE member_id=$1`,
            [member]
          )
        ).rows[0].count,
        0
      );
    }
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM public.evaluations WHERE member_id=$1",
          [survivor]
        )
      ).rows[0].count,
      1
    );
    assert.equal(
      (await admin.query("SELECT count(*)::int AS count FROM auth.users WHERE id=$1", [owner]))
        .rows[0].count,
      1
    );
    await assert.rejects(
      api.laddersDeleteMember(account.id, workspace, member),
      /Member unavailable/
    );
    await api.laddersDeleteTeam(account.id, workspace, team);
    assert.equal(
      (
        await admin.query("SELECT team_id FROM public.shiplog_applications WHERE id=$1", [
          application,
        ])
      ).rows[0].team_id,
      null
    );
    await assert.rejects(api.laddersDeleteTeam(account.id, workspace, team), /Team unavailable/);
    await assert.rejects(
      api.pool.query("DELETE FROM public.members WHERE id=$1", [survivor]),
      /permission denied/
    );
    await admin.query("DELETE FROM public.members WHERE id=$1", [survivor]);
    await assert.rejects(api.laddersDeleteTeam(account.id, workspace, defaultTeam), /default team/);
    await admin.query("DELETE FROM public.shiplog_applications WHERE id=$1", [application]);
    await admin.query("DELETE FROM public.shiplog_audit_events WHERE workspace_id=$1", [workspace]);
    await admin.query("DELETE FROM public.teams WHERE id=$1", [defaultTeam]);
    const remaining = (
      await admin.query("SELECT created_for_team FROM public.workspaces WHERE id=$1", [workspace])
    ).rows[0];
    assert.deepEqual(remaining, { created_for_team: false });
    assert.equal((await api.workspaces(account.id, "ladders")).length, 2);
    const lastTeam = randomUUID();
    await admin.query("UPDATE public.workspaces SET created_for_team=true WHERE id=$1", [other]);
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$2,$3,'Last legacy container')",
      [lastTeam, owner, other]
    );
    await api.laddersDeleteTeam(account.id, other, lastTeam);
    assert.deepEqual(
      (await admin.query("SELECT created_for_team FROM public.workspaces WHERE id=$1", [other]))
        .rows[0],
      { created_for_team: false }
    );
    assert.equal((await api.workspaces(account.id, "ladders")).length, 2);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.laddersDeleteTeam(account.id, workspace, randomUUID()),
      /owner access/
    );
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.members WHERE id=ANY($1::uuid[])", [[member, survivor]]);
    await admin.query(
      "DELETE FROM public.shiplog_applications WHERE workspace_id=ANY($1::uuid[])",
      [[workspace, other]]
    );
    await admin.query(
      "DELETE FROM public.shiplog_audit_events WHERE workspace_id=ANY($1::uuid[])",
      [[workspace, other]]
    );
    await admin.query("DELETE FROM public.teams WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
