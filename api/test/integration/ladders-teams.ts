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
test("Ladders directory and team writes are explicit-grant scoped without legacy tokens or identity inference", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID();
  const team = randomUUID(),
    foreignTeam = randomUUID(),
    member = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-teams.invalid",
    subject: randomUUID(),
    email: "same@example.invalid",
  });
  const unlinked = await api.account({
    issuer: "https://ladders-teams.invalid",
    subject: randomUUID(),
    email: "same@example.invalid",
  });
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Ladders integration'),($2,$3,'Other Ladders integration')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'Core'),($2,$3,$5,'Foreign')",
      [team, foreignTeam, owner, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.members(id,owner_id,team_id,name,role) VALUES($1,$2,$3,'Local member','Developer')",
      [member, owner, team]
    );
    await admin.query("COMMIT");
    await assert.rejects(api.laddersTeams(account.id, workspace), /Internal Ladders/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner')",
      [account.id, workspace]
    );
    await assert.rejects(api.laddersTeams(account.id, workspace), /Internal Ladders/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'viewer')",
      [account.id, workspace]
    );
    assert.deepEqual(await api.laddersTeams(account.id, workspace), {
      teams: [{ id: team, name: "Core" }],
      members: [
        {
          id: member,
          team_id: team,
          name: "Local member",
          role: "Developer",
          planning_role: null,
          template_id: null,
        },
      ],
    });
    await assert.rejects(api.laddersTeams(unlinked.id, workspace), /Internal Ladders/);
    await assert.rejects(
      api.laddersSaveTeam(account.id, workspace, "New", null),
      /management access/
    );
    await assert.rejects(
      api.laddersSaveTeam(account.id, workspace, "Renamed", team),
      /management access/
    );
    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await assert.rejects(
      api.laddersSaveTeam(account.id, workspace, "New", null),
      /management access/
    );
    await api.laddersSaveTeam(account.id, workspace, "  Renamed  ", team);
    assert.equal(
      (await admin.query("SELECT name FROM public.teams WHERE id=$1", [team])).rows[0].name,
      "Renamed"
    );
    await assert.rejects(
      api.laddersSaveTeam(account.id, workspace, "Foreign write", foreignTeam),
      /Team unavailable/
    );
    await assert.rejects(api.laddersSaveTeam(account.id, workspace, "", team), /Team names/);
    await assert.rejects(
      api.laddersSaveTeam(account.id, workspace, "x".repeat(121), team),
      /Team names/
    );
    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await api.laddersSaveTeam(account.id, workspace, "x".repeat(120), null);
    assert.equal(
      (
        await admin.query("SELECT count(*)::int AS count FROM public.teams WHERE workspace_id=$1", [
          workspace,
        ])
      ).rows[0].count,
      2
    );
    assert.equal(
      (
        await admin.query("SELECT owner_id FROM public.teams WHERE workspace_id=$1 AND id<>$2", [
          workspace,
          team,
        ])
      ).rows[0].owner_id,
      owner
    );
    await assert.rejects(api.pool.query("SELECT * FROM public.members"), /permission denied/);
    await assert.rejects(api.laddersTeams(account.id, other), /Internal Ladders/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'owner')",
      [account.id, other]
    );
    await assert.rejects(
      api.laddersSaveTeam(account.id, other, "Wrong scope", team),
      /Team unavailable/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(api.laddersTeams(account.id, workspace), /Internal Ladders/);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=ANY($1::uuid[])", [
      [account.id, unlinked.id],
    ]);
    await admin.query("DELETE FROM public.members WHERE id=$1", [member]);
    await admin.query("DELETE FROM public.teams WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [
      [account.id, unlinked.id],
    ]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [
      [account.id, unlinked.id],
    ]);
    await admin.end();
    await api.pool.end();
  }
});
