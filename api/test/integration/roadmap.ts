import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { buildPublicRoadmap } from "../../dist/scheduler.mjs";

const adminURL = process.env.DATABASE_URL;
const apiURL = process.env.API_DATABASE_URL;
if (!adminURL || !apiURL || new URL(adminURL).hostname !== "db")
  throw new Error("Integration tests require isolated Docker database URLs");

test("the API reuses Planner scheduling while keeping private inputs behind grant checks", async () => {
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
    const shares = await admin.query<{ workspace_id: string; token: string }>(
      "SELECT workspace_id,token FROM public.roadmap_shares LIMIT 1"
    );
    const share = shares.rows[0];
    assert.ok(share, "Local copy must have an existing roadmap for comparison");
    await assert.rejects(
      api.plannerSource(account.id, share.workspace_id),
      /Workspace access required/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'external')",
      [account.id, share.workspace_id]
    );
    const source = await api.plannerSource(account.id, share.workspace_id);
    const legacy = await admin.query<{ source: unknown }>(
      "SELECT public.planner_roadmap_source($1) AS source",
      [share.token]
    );
    const projected = buildPublicRoadmap(source);
    const expected = buildPublicRoadmap(legacy.rows[0]!.source);
    assert.ok(
      projected &&
        typeof projected === "object" &&
        "features" in projected &&
        "markers" in projected
    );
    assert.ok(
      expected && typeof expected === "object" && "features" in expected && "markers" in expected
    );
    assert.deepEqual(projected.features, expected.features);
    assert.deepEqual(projected.markers, expected.markers);
    assert.deepEqual(Object.keys(projected).sort(), [
      "features",
      "markers",
      "name",
      "revision",
      "startDate",
    ]);
    assert.ok(Array.isArray(projected.features));
    for (const feature of projected.features)
      assert.deepEqual(Object.keys(feature).sort(), [
        "complete",
        "dependency_ids",
        "end",
        "id",
        "name",
        "project",
        "start",
        "status",
      ]);
    await assert.rejects(api.plannerSource(account.id, randomUUID()), /Workspace access required/);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.plannerSource(account.id, share.workspace_id),
      /Workspace access required/
    );
  } finally {
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
