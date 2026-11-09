import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { releaseInput } from "../../src/shiplog-input.js";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Isolated Docker database required");

test("Shiplog checklist templates are owner-only, revision checked and snapshotted; completion never impersonates legacy actors", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const account = await api.account({
    issuer: "https://shiplog-checklists.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const second = await api.account({
    issuer: "https://shiplog-checklists.invalid",
    subject: randomUUID(),
    email: "second@example.invalid",
  });
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    app = randomUUID(),
    foreignApp = randomUUID();
  const item = { category: "QA", title: "Smoke test", description: "Check flow", mandatory: true };
  const grant = (id: string, role: string) =>
    admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'shiplog',$2,$3) ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role",
      [id, workspace, role]
    );
  const makeRelease = async (version: string) => {
    const result = await api.shiplogSaveRelease(
      account.id,
      workspace,
      releaseInput({
        application_id: app,
        version,
        title: "Release",
        public_notes: "",
        status: "released",
        feature_ids: null,
      }),
      null
    );
    assert.ok(
      result && typeof result === "object" && "id" in result && typeof result.id === "string"
    );
    return result.id;
  };
  const items = async (release: string) =>
    (
      await admin.query(
        "SELECT id,title,completed_by,completed_at FROM public.shiplog_checklist_items WHERE release_id=$1 ORDER BY position",
        [release]
      )
    ).rows;
  try {
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Checklist test'),($2,$3,'Other checklist test')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.shiplog_applications(id,workspace_id,name) VALUES($1,$3,'App'),($2,$4,'Other app')",
      [app, foreignApp, workspace, other]
    );
    await assert.rejects(
      api.shiplogChecklistTemplate(account.id, workspace, app),
      /Internal Shiplog/
    );
    await grant(account.id, "external");
    await assert.rejects(
      api.shiplogChecklistTemplate(account.id, workspace, app),
      /Internal Shiplog/
    );
    for (const role of ["viewer", "editor"]) {
      await grant(account.id, role);
      assert.deepEqual(await api.shiplogChecklistTemplate(account.id, workspace, app), {
        revision: 0,
        items: [],
      });
      await assert.rejects(
        api.shiplogSaveChecklistTemplate(account.id, workspace, app, {
          revision: 0,
          items: [item],
        }),
        /owner access/
      );
    }
    await grant(account.id, "owner");
    const emptyRelease = await makeRelease("1.0.0");
    assert.deepEqual(await items(emptyRelease), []);
    assert.deepEqual(
      await api.shiplogSaveChecklistTemplate(account.id, workspace, app, {
        revision: 0,
        items: [item],
      }),
      { revision: 1, items: [item] }
    );
    const release = await makeRelease("1.0.1"),
      snapshot = await items(release);
    assert.equal(snapshot.length, 1);
    const itemId: string = snapshot[0].id;
    await assert.rejects(
      api.shiplogSaveChecklistTemplate(account.id, workspace, app, { revision: 0, items: [] }),
      /changed/
    );
    await assert.rejects(
      api.shiplogSaveChecklistTemplate(account.id, workspace, foreignApp, {
        revision: 0,
        items: [],
      }),
      /Application unavailable/
    );
    await api.shiplogSaveChecklistTemplate(account.id, workspace, app, {
      revision: 1,
      items: [{ ...item, title: "Future test" }],
    });
    const legacyRelease = await makeRelease("1.0.2");
    const legacyItem = (await items(legacyRelease))[0];
    await admin.query(
      "UPDATE public.shiplog_checklist_items SET completed_by=$2,completed_at=now() WHERE id=$1",
      [legacyItem.id, owner]
    );
    const legacySnapshot = await items(legacyRelease);
    await api.shiplogCompleteChecklistItem(
      account.id,
      workspace,
      legacyRelease,
      legacyItem.id,
      true
    );
    assert.deepEqual(await items(legacyRelease), legacySnapshot);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM platform.shiplog_checklist_completions WHERE item_id=$1",
          [legacyItem.id]
        )
      ).rows[0].n,
      0
    );
    assert.deepEqual(await items(release), snapshot);
    assert.deepEqual(await items(emptyRelease), []);
    await assert.rejects(
      api.shiplogCompleteChecklistItem(account.id, workspace, emptyRelease, itemId, true),
      /item unavailable/
    );
    await assert.rejects(api.shiplogReadiness(account.id, other, release), /Internal Shiplog/);
    await grant(account.id, "viewer");
    await api.shiplogReadiness(account.id, workspace, release);
    await assert.rejects(
      api.shiplogCompleteChecklistItem(account.id, workspace, release, itemId, true),
      /edit access/
    );
    await grant(account.id, "editor");
    await api.shiplogCompleteChecklistItem(account.id, workspace, release, itemId, true);
    const completion = (
      await admin.query(
        "SELECT actor_id,completed_at FROM platform.shiplog_checklist_completions WHERE item_id=$1",
        [itemId]
      )
    ).rows[0];
    assert.equal(completion.actor_id, account.id);
    assert.deepEqual(await items(release), snapshot);
    await grant(second.id, "editor");
    await api.shiplogCompleteChecklistItem(second.id, workspace, release, itemId, true);
    assert.deepEqual(
      (
        await admin.query(
          "SELECT actor_id,completed_at FROM platform.shiplog_checklist_completions WHERE item_id=$1",
          [itemId]
        )
      ).rows[0],
      completion
    );
    await api.shiplogCompleteChecklistItem(second.id, workspace, release, itemId, false);
    const unchecked = await api.shiplogReadiness(account.id, workspace, release);
    assert.ok(
      unchecked &&
        typeof unchecked === "object" &&
        "items" in unchecked &&
        Array.isArray(unchecked.items)
    );
    assert.equal(unchecked.items[0].completed_by, null);
    assert.equal(unchecked.items[0].completed_at, null);
    await admin.query(
      "UPDATE public.shiplog_checklist_items SET completed_by=$2,completed_at=now() WHERE id=$1",
      [itemId, owner]
    );
    const legacy = await items(release);
    const overridden = await api.shiplogReadiness(account.id, workspace, release);
    assert.ok(
      overridden &&
        typeof overridden === "object" &&
        "items" in overridden &&
        Array.isArray(overridden.items)
    );
    assert.equal(overridden.items[0].completed_at, null);
    await api.shiplogCompleteChecklistItem(second.id, workspace, release, itemId, true);
    assert.deepEqual(await items(release), legacy);
    const latest = await api.shiplogReadiness(account.id, workspace, release);
    assert.ok(
      latest && typeof latest === "object" && "items" in latest && Array.isArray(latest.items)
    );
    assert.equal(latest.items[0].completed_by, second.id);
    assert.equal(
      (await admin.query("SELECT status FROM public.shiplog_releases WHERE id=$1", [release]))
        .rows[0].status,
      "released"
    );
    await assert.rejects(
      api.pool.query("SELECT * FROM platform.shiplog_checklist_completions"),
      /permission denied/
    );
    await grant(account.id, "external");
    await assert.rejects(api.shiplogReadiness(account.id, workspace, release), /Internal Shiplog/);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [second.id]);
    await assert.rejects(
      api.shiplogCompleteChecklistItem(second.id, workspace, release, itemId, false),
      /edit access/
    );
    const audit = (
      await admin.query(
        "SELECT actor_id FROM platform.shiplog_audit_events WHERE workspace_id=$1",
        [workspace]
      )
    ).rows;
    assert.ok(audit.every((row) => row.actor_id === account.id || row.actor_id === second.id));
  } finally {
    await admin.query("DELETE FROM platform.grants WHERE user_id=ANY($1::uuid[])", [
      [account.id, second.id],
    ]);
    await admin.query("DELETE FROM public.shiplog_releases WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query(
      "DELETE FROM public.shiplog_applications WHERE workspace_id=ANY($1::uuid[])",
      [[workspace, other]]
    );
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [
      [account.id, second.id],
    ]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [
      [account.id, second.id],
    ]);
    await admin.end();
    await api.pool.end();
  }
});
