import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";

const adminURL = process.env.DATABASE_URL;
const apiURL = process.env.API_DATABASE_URL;
if (!adminURL || !apiURL || new URL(adminURL).hostname !== "db")
  throw new Error("Integration tests require isolated Docker database URLs");

test("workspace directory and catalog are grant-scoped and expose only the former reduced projection", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const subject = randomUUID();
  const account = await api.account({
    issuer: "https://test.example",
    subject,
    email: `${subject}@example.com`,
  });
  try {
    const source = await admin.query<{ id: string }>(
      "SELECT workspace_id AS id FROM public.shiplog_releases LIMIT 1"
    );
    const workspace = source.rows[0]?.id;
    assert.ok(workspace, "Local copy must have Shiplog releases");
    assert.deepEqual(await api.workspaces(account.id, "shiplog"), []);
    await assert.rejects(api.shiplogCatalog(account.id, workspace), /Workspace access required/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'external')",
      [account.id, workspace]
    );
    await assert.rejects(api.shiplogCatalog(account.id, workspace), /Workspace access required/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'shiplog',$2,'external')",
      [account.id, workspace]
    );
    const directory = await api.workspaces(account.id, "shiplog");
    assert.equal(directory.length, 1);
    assert.equal(directory[0]!.id, workspace);
    const catalog = await api.shiplogCatalog(account.id, workspace);
    assert.ok(catalog && typeof catalog === "object" && "releases" in catalog);
    assert.deepEqual(Object.keys(catalog).sort(), ["applications", "name", "releases"]);
    assert.ok(Array.isArray(catalog.releases));
    assert.ok(catalog.releases.length);
    for (const release of catalog.releases) {
      assert.deepEqual(Object.keys(release).sort(), [
        "application_id",
        "created_at",
        "features",
        "id",
        "public_notes",
        "release_type",
        "status",
        "title",
        "version",
      ]);
      assert.ok(Array.isArray(release.features));
      for (const feature of release.features) assert.deepEqual(Object.keys(feature), ["name"]);
    }
    await assert.rejects(api.shiplogCatalog(account.id, randomUUID()), /Workspace access required/);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1 AND app='shiplog'", [
      account.id,
    ]);
    await assert.rejects(api.shiplogCatalog(account.id, workspace), /Workspace access required/);
    await assert.rejects(
      api.pool.query("SELECT public.shiplog_public_release_content(gen_random_uuid())"),
      /permission denied/
    );
  } finally {
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
