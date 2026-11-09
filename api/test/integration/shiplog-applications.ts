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
test("Shiplog application writes are grant-scoped, audited by platform identity and protect nonempty applications", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const account = await api.account({
    issuer: "https://shiplog-integration.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    team = randomUUID(),
    otherTeam = randomUUID();
  try {
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Shiplog applications integration'),($2,$3,'Other applications integration')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'Core'),($2,$3,$5,'Private other team')",
      [team, otherTeam, owner, workspace, other]
    );
    await assert.rejects(api.shiplogApplications(account.id, workspace), /Internal Shiplog/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'shiplog',$2,'external')",
      [account.id, workspace]
    );
    await assert.rejects(api.shiplogApplications(account.id, workspace), /Internal Shiplog/);
    await admin.query("UPDATE platform.grants SET role='viewer' WHERE user_id=$1", [account.id]);
    assert.deepEqual(await api.shiplogApplications(account.id, workspace), {
      applications: [],
      teams: [{ id: team, name: "Core" }],
    });
    const input = { name: "  App  ", description: "Private description", team_id: team };
    await assert.rejects(
      api.shiplogSaveApplication(account.id, workspace, input, null),
      /edit access/
    );
    await admin.query("UPDATE platform.grants SET role='editor' WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.shiplogSaveApplication(account.id, workspace, { ...input, team_id: otherTeam }, null),
      /Team unavailable/
    );
    await api.shiplogSaveApplication(account.id, workspace, input, null);
    const created = (
      await admin.query(
        "SELECT id,created_at FROM public.shiplog_applications WHERE workspace_id=$1",
        [workspace]
      )
    ).rows[0];
    assert.ok(created);
    await api.shiplogSaveApplication(
      account.id,
      workspace,
      { ...input, name: "Renamed", team_id: null },
      created.id
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT id,created_at,name,team_id FROM public.shiplog_applications WHERE id=$1",
          [created.id]
        )
      ).rows[0],
      { ...created, name: "Renamed", team_id: null }
    );
    await assert.rejects(
      api.shiplogDeleteApplication(account.id, other, created.id),
      /edit access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'shiplog',$2,'editor')",
      [account.id, other]
    );
    await assert.rejects(
      api.shiplogSaveApplication(account.id, other, input, created.id),
      /Team unavailable/
    );
    await assert.rejects(
      api.shiplogDeleteApplication(account.id, other, created.id),
      /Application unavailable/
    );
    await admin.query(
      "INSERT INTO public.shiplog_releases(workspace_id,application_id,version,release_type,title) VALUES($1,$2,'1.0.0','major','Draft')",
      [workspace, created.id]
    );
    await assert.rejects(
      api.shiplogDeleteApplication(account.id, workspace, created.id),
      /with releases/
    );
    const directory = await api.shiplogApplications(account.id, workspace);
    assert.ok(
      directory &&
        typeof directory === "object" &&
        "applications" in directory &&
        Array.isArray(directory.applications)
    );
    assert.equal(directory.applications[0].in_use, true);
    await admin.query("DELETE FROM public.shiplog_releases WHERE application_id=$1", [created.id]);
    await api.shiplogDeleteApplication(account.id, workspace, created.id);
    const audit = (
      await admin.query(
        "SELECT actor_id,event FROM platform.shiplog_audit_events WHERE workspace_id=$1 ORDER BY created_at,id",
        [workspace]
      )
    ).rows;
    assert.deepEqual(audit.map((row) => row.event).sort(), [
      "application.created",
      "application.deleted",
      "application.updated",
    ]);
    assert.ok(audit.every((row) => row.actor_id === account.id));
    await assert.rejects(
      api.pool.query("SELECT * FROM platform.shiplog_audit_events"),
      /permission denied/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(api.shiplogApplications(account.id, workspace), /Internal Shiplog/);
  } finally {
    await admin.query("DELETE FROM public.shiplog_releases WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query(
      "DELETE FROM public.shiplog_applications WHERE workspace_id=ANY($1::uuid[])",
      [[workspace, other]]
    );
    await admin.query("DELETE FROM public.teams WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
