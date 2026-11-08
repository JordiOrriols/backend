import { test } from "node:test";
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
  throw new Error("Integration tests require isolated Docker database URLs");

test("marker writes require owner/editor grants and preserve marker identity and date on rename", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    otherWorkspace = randomUUID();
  const account = await api.account({
    issuer: "https://marker-test.example",
    subject: randomUUID(),
    email: "marker-test@example.com",
  });
  try {
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    for (const id of [workspace, otherWorkspace])
      await admin.query(
        "INSERT INTO public.workspaces(id,owner_id,name,plan_start_date) VALUES($1,$2,'Local marker test','2026-02-02')",
        [id, owner]
      );
    await assert.rejects(
      api.plannerMarkers(account.id, workspace),
      /Internal Planner access required/
    );
    for (const role of ["external", "viewer"]) {
      await admin.query(
        `INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,$3)
        ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role`,
        [account.id, workspace, role]
      );
      if (role === "viewer") assert.deepEqual(await api.plannerMarkers(account.id, workspace), []);
      else
        await assert.rejects(
          api.plannerMarkers(account.id, workspace),
          /Internal Planner access required/
        );
      await assert.rejects(
        api.plannerMarker(account.id, workspace, "create", null, "Denied", "2026-02-02"),
        /Internal Planner access required/
      );
    }
    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND workspace_id=$2",
      [account.id, workspace]
    );
    const created = await api.plannerMarker(
      account.id,
      workspace,
      "create",
      null,
      " Launch ",
      "2026-02-04"
    );
    assert.ok(
      created && typeof created === "object" && "id" in created && typeof created.id === "string"
    );
    const marker = { id: created.id, workspace_id: workspace, name: "Launch", date: "2026-02-04" };
    assert.deepEqual(created, marker);
    assert.deepEqual(await api.plannerMarkers(account.id, workspace), [marker]);
    assert.deepEqual(
      await api.plannerMarker(account.id, workspace, "rename", marker.id, "Release", null),
      {
        ...marker,
        name: "Release",
      }
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner')",
      [account.id, otherWorkspace]
    );
    for (const action of ["rename", "delete"] as const)
      await assert.rejects(
        api.plannerMarker(account.id, otherWorkspace, action, marker.id, "Denied", null),
        /Marker unavailable/
      );
    await assert.rejects(
      api.pool.query("UPDATE public.roadmap_markers SET name='Direct write'"),
      /permission denied/
    );
    await api.plannerMarker(account.id, workspace, "delete", marker.id, null, null);
    assert.deepEqual(await api.plannerMarkers(account.id, workspace), []);
    await assert.rejects(
      api.plannerMarker(account.id, workspace, "delete", marker.id, null, null),
      /Marker unavailable/
    );
    await api.plannerMarker(
      account.id,
      otherWorkspace,
      "create",
      null,
      "Owner marker",
      "2026-02-05"
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.plannerMarkers(account.id, otherWorkspace),
      /Internal Planner access required/
    );
  } finally {
    await admin.query("DELETE FROM public.roadmap_markers WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, otherWorkspace],
    ]);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, otherWorkspace],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
