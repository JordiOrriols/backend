import { test } from "node:test";
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
  throw new Error("Integration tests require the isolated Docker API database URL");

test("local administrator grants, changes and revokes only the selected account/app/workspace", async () => {
  const admin = new Client({ connectionString: adminURL });
  const restricted = new Client({ connectionString: apiURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  await restricted.connect();
  const ids: string[] = [];
  const identity = {
    issuer: "https://permissions-test.example",
    subject: randomUUID(),
    email: "permissions-test@example.com",
  };
  const otherIdentity = { ...identity, subject: randomUUID() };
  try {
    const first = await api.account(identity);
    ids.push(first.id);
    const other = await api.account(otherIdentity);
    ids.push(other.id);
    const { rows } = await admin.query<{ id: string }>(
      "SELECT id FROM public.workspaces ORDER BY id LIMIT 2"
    );
    const workspace = rows[0]?.id;
    const untouched = rows[1]?.id;
    assert.ok(workspace && untouched, "Local copy must contain two workspaces");
    const users = await runPermissionCommand(admin, ["users"]);
    assert.ok(Array.isArray(users));
    assert.deepEqual(
      users.find((user) => user.id === first.id),
      {
        id: first.id,
        email: identity.email,
        issuer: identity.issuer,
        subject: identity.subject,
      }
    );
    const workspaces = await runPermissionCommand(admin, ["workspaces"]);
    assert.ok(Array.isArray(workspaces));
    assert.ok(workspaces.some((entry) => entry.id === workspace));
    await runPermissionCommand(admin, ["grant", first.id, "planner", workspace, "external"]);
    const grants = await runPermissionCommand(admin, ["grants"]);
    assert.ok(Array.isArray(grants));
    assert.deepEqual(
      grants.find((entry) => entry.user_id === first.id),
      {
        user_id: first.id,
        app: "planner",
        workspace_id: workspace,
        role: "external",
      }
    );
    assert.deepEqual((await api.account(identity)).grants, [
      { app: "planner", workspaceId: workspace, role: "external" },
    ]);
    assert.deepEqual((await api.account(otherIdentity)).grants, []);
    await runPermissionCommand(admin, ["grant", first.id, "planner", workspace, "editor"]);
    assert.deepEqual((await api.account(identity)).grants, [
      { app: "planner", workspaceId: workspace, role: "editor" },
    ]);
    await runPermissionCommand(admin, ["grant", first.id, "shiplog", untouched, "external"]);
    await assert.rejects(
      runPermissionCommand(admin, ["grant", randomUUID(), "planner", workspace, "owner"]),
      /Unknown platform user/
    );
    const unlinked = await admin.query<{ id: string }>(
      "INSERT INTO platform.users(email) VALUES('unlinked-permissions-test@example.com') RETURNING id"
    );
    const unlinkedId = unlinked.rows[0]!.id;
    ids.push(unlinkedId);
    await assert.rejects(
      runPermissionCommand(admin, ["grant", unlinkedId, "planner", workspace, "owner"]),
      /Unknown platform user/
    );
    await assert.rejects(
      runPermissionCommand(admin, ["grant", first.id, "planner", randomUUID(), "owner"]),
      /Unknown workspace/
    );
    await assert.rejects(
      runPermissionCommand(admin, ["grant", first.id, "ladders", workspace, "external"]),
      /External access/
    );
    await assert.rejects(
      runPermissionCommand(restricted, ["grant", first.id, "planner", workspace, "owner"]),
      /permission denied/
    );
    await assert.rejects(
      runPermissionCommand(restricted, ["revoke", first.id, "planner", workspace]),
      /permission denied/
    );
    await runPermissionCommand(admin, ["revoke", first.id, "planner", workspace]);
    await assert.rejects(
      runPermissionCommand(admin, ["revoke", first.id, "planner", workspace]),
      /No matching grant/
    );
    assert.deepEqual((await api.account(identity)).grants, [
      { app: "shiplog", workspaceId: untouched, role: "external" },
    ]);
    await assert.rejects(api.plannerSource(first.id, workspace), /Workspace access required/);
  } finally {
    await admin.query("DELETE FROM platform.grants WHERE user_id=ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [ids]);
    await admin.end();
    await restricted.end();
    await api.pool.end();
  }
});
