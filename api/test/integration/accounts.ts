import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";

const adminURL = process.env.DATABASE_URL;
const apiURL = process.env.API_DATABASE_URL;
if (!adminURL || !apiURL || new URL(adminURL).hostname !== "db")
  throw new Error("Integration tests require isolated Docker database URLs");

test("new identities have no grants, remain stable and never inherit email permissions", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const subject = randomUUID();
  const identity = { issuer: "https://test.example", subject, email: `${subject}@example.com` };
  const ids: string[] = [];
  try {
    const accounts = await Promise.all([api.account(identity), api.account(identity)]);
    ids.push(accounts[0]!.id);
    assert.equal(accounts[0]!.id, accounts[1]!.id);
    assert.deepEqual(accounts[0]!.grants, []);
    const workspaces = await admin.query<{ id: string }>(
      "SELECT id FROM public.workspaces LIMIT 1"
    );
    const workspace = workspaces.rows[0]?.id;
    assert.ok(workspace, "Restored production copy must have a workspace");
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'external')",
      [ids[0], workspace]
    );
    assert.deepEqual((await api.account(identity)).grants, [
      { app: "planner", workspaceId: workspace, role: "external" },
    ]);
    const other = await api.account({ ...identity, subject: randomUUID() });
    ids.push(other.id);
    assert.notEqual(other.id, ids[0]);
    assert.deepEqual(other.grants, []);
    assert.equal((await api.account({ ...identity, email: "changed@example.com" })).id, ids[0]);
    await assert.rejects(
      admin.query(
        "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'external')",
        [ids[0], workspace]
      )
    );
    await assert.rejects(api.pool.query("SELECT id FROM public.members"), /permission denied/);
    await assert.rejects(api.pool.query("SELECT id FROM auth.users"), /permission denied/);
    await assert.rejects(
      api.pool.query(
        "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'agents',$2,'owner')",
        [ids[0], workspace]
      ),
      /permission denied/
    );
  } finally {
    await admin.query("DELETE FROM platform.grants WHERE user_id=ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [ids]);
    await admin.end();
    await api.pool.end();
  }
});
