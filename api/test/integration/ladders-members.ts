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
test("Ladders creates unlinked members only through explicit scoped edit grants and retains legacy insert rules", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    team = randomUUID(),
    foreign = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-members.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const input = {
    name: " New member ",
    role: " Developer ",
    planning_role: "backend" as const,
    template_id: "D3",
  };
  try {
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Members integration'),($2,$3,'Other members integration')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'Member team'),($2,$3,$5,'Foreign team')",
      [team, foreign, owner, workspace, other]
    );
    await assert.rejects(
      api.laddersCreateMember(account.id, workspace, team, input),
      /edit access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner'),($1,'ladders',$2,'viewer')",
      [account.id, workspace]
    );
    await assert.rejects(
      api.laddersCreateMember(account.id, workspace, team, input),
      /edit access/
    );
    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await assert.rejects(
      api.laddersCreateMember(account.id, workspace, foreign, input),
      /Team unavailable/
    );
    await assert.rejects(
      api.pool.query("INSERT INTO public.members(team_id,name) VALUES($1,'Direct')", [team]),
      /permission denied/
    );
    await assert.rejects(
      admin.query("INSERT INTO public.members(team_id,name) VALUES($1,'Legacy unauthenticated')", [
        team,
      ]),
      /team edit access/
    );
    await assert.rejects(
      api.pool.query("SELECT platform.ladders_create_member($1,$2,$3,$4)", [
        account.id,
        workspace,
        team,
        { ...input, name: "" },
      ]),
      /Invalid member profile/
    );
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM public.members WHERE team_id=$1", [team]))
        .rows[0].n,
      0
    );
    const created = await api.laddersCreateMember(account.id, workspace, team, input);
    assert.ok(
      created && typeof created === "object" && "id" in created && typeof created.id === "string"
    );
    assert.deepEqual(Object.keys(created), ["id"]);
    const row = (
      await admin.query(
        "SELECT owner_id,team_id,user_id,name,role,planning_role,template_id,view_enabled,self_token,peer_token,view_token,vacation_token FROM public.members WHERE id=$1",
        [created.id]
      )
    ).rows[0];
    assert.equal(row.owner_id, owner);
    assert.equal(row.team_id, team);
    assert.equal(row.user_id, null);
    assert.equal(row.view_enabled, false);
    assert.equal(row.name, "New member");
    assert.equal(row.role, "Developer");
    assert.equal(row.planning_role, "backend");
    assert.equal(row.template_id, "D3");
    assert.equal(
      new Set([row.self_token, row.peer_token, row.view_token, row.vacation_token]).size,
      4
    );
    assert.notEqual(row.owner_id, account.id);
    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await api.laddersCreateMember(account.id, workspace, team, {
      ...input,
      name: "😀".repeat(120),
      planning_role: null,
      template_id: null,
    });
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.laddersCreateMember(account.id, workspace, team, input),
      /edit access/
    );
  } finally {
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.members WHERE team_id=ANY($1::uuid[])", [
      [team, foreign],
    ]);
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
