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

test("Shiplog release configuration preserves SemVer, frozen history, scoped links and atomic platform audit", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const account = await api.account({
    issuer: "https://shiplog-releases.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    app = randomUUID(),
    otherApp = randomUUID(),
    project = randomUUID(),
    otherProject = randomUUID(),
    feature = randomUUID(),
    foreignFeature = randomUUID();
  const input = releaseInput({
    application_id: app,
    version: "1.0.0",
    title: "First",
    public_notes: "Notes",
    status: "draft",
    feature_ids: null,
  });
  const save = (changes = {}, id: string | null = null) =>
    api.shiplogSaveRelease(account.id, workspace, { ...input, ...changes }, id);
  const grant = (application: string, scope: string, role: string) =>
    admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role",
      [account.id, application, scope, role]
    );
  try {
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Release test'),($2,$3,'Other release test')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.shiplog_applications(id,workspace_id,name) VALUES($1,$3,'App'),($2,$4,'Other app')",
      [app, otherApp, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.projects(id,workspace_id,name) VALUES($1,$3,'Project'),($2,$4,'Other project')",
      [project, otherProject, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.features(id,project_id,name) VALUES($1,$3,'Linked change'),($2,$4,'Private other change')",
      [feature, foreignFeature, project, otherProject]
    );
    for (const role of [null, "external", "viewer"]) {
      if (role) await grant("shiplog", workspace, role);
      await assert.rejects(save(), /edit access/);
    }
    await grant("shiplog", workspace, "editor");
    await assert.rejects(api.shiplogWorkspaceFeatures(account.id, workspace), /Planner access/);
    await assert.rejects(save({ feature_ids: [feature] }), /Planner access/);
    await grant("planner", workspace, "external");
    await assert.rejects(api.shiplogWorkspaceFeatures(account.id, workspace), /Planner access/);
    await grant("planner", workspace, "viewer");
    assert.deepEqual(await api.shiplogWorkspaceFeatures(account.id, workspace), [
      { id: feature, name: "Linked change", linked: false },
    ]);
    await assert.rejects(save({ feature_ids: [foreignFeature] }), /Planner feature unavailable/);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM public.shiplog_releases WHERE workspace_id=$1",
          [workspace]
        )
      ).rows[0].n,
      0
    );
    const result = await save({ feature_ids: [feature, feature] });
    assert.ok(
      result && typeof result === "object" && "id" in result && typeof result.id === "string"
    );
    const id = result.id;
    assert.ok("release_type" in result && result.release_type === "major");
    const original = (
      await admin.query("SELECT created_at,created_by FROM public.shiplog_releases WHERE id=$1", [
        id,
      ])
    ).rows[0];
    assert.equal(original.created_by, null);
    assert.equal(
      (
        await admin.query(
          "SELECT template_revision FROM public.shiplog_readiness WHERE release_id=$1",
          [id]
        )
      ).rows[0].template_revision,
      0
    );
    await assert.rejects(save(), /version already exists/);
    await grant("shiplog", other, "editor");
    await assert.rejects(
      api.shiplogSaveRelease(account.id, other, { ...input, application_id: otherApp }, id),
      /Release unavailable/
    );
    await assert.rejects(save({ application_id: otherApp }, id), /Application unavailable/);
    await admin.query("UPDATE public.features SET name='Renamed Planner feature' WHERE id=$1", [
      feature,
    ]);
    assert.deepEqual(await api.shiplogReleaseFeatures(account.id, workspace, id), [
      { id: feature, name: "Linked change", linked: true },
    ]);
    await assert.rejects(
      save({ title: "Must roll back", feature_ids: [foreignFeature] }, id),
      /Planner feature unavailable/
    );
    assert.equal(
      (await admin.query("SELECT title FROM public.shiplog_releases WHERE id=$1", [id])).rows[0]
        .title,
      "First"
    );
    await save({ version: "1.0.1" });
    await save({ version: "1.1.0-rc.1+test", title: "Minor", feature_ids: [], status: "qa" }, id);
    assert.deepEqual(await api.shiplogReleaseFeatures(account.id, workspace, id), []);
    const qa = {
      ...input,
      version: "1.1.0-rc.1+test",
      title: "Minor",
      status: "qa" as const,
      feature_ids: null,
    };
    await assert.rejects(
      api.shiplogSaveRelease(account.id, workspace, { ...qa, title: "Frozen" }, id),
      /Only drafts/
    );
    await assert.rejects(
      api.shiplogSaveRelease(account.id, workspace, { ...qa, feature_ids: [] }, id),
      /Only drafts/
    );
    await api.shiplogSaveRelease(
      account.id,
      workspace,
      { ...qa, public_notes: "Updated notes", status: "released" },
      id
    );
    const saved = (
      await admin.query(
        "SELECT created_at,created_by,release_type,status,public_notes FROM public.shiplog_releases WHERE id=$1",
        [id]
      )
    ).rows[0];
    assert.deepEqual(saved, {
      ...original,
      release_type: "minor",
      status: "released",
      public_notes: "Updated notes",
    });
    const patch = await save({ version: "1.1.0", feature_ids: null });
    assert.ok(
      patch &&
        typeof patch === "object" &&
        "release_type" in patch &&
        patch.release_type === "patch"
    );
    await grant("shiplog", workspace, "viewer");
    await assert.rejects(save({ version: "2.0.0" }), /edit access/);
    await api.shiplogReleaseFeatures(account.id, workspace, id);
    await grant("shiplog", workspace, "external");
    await assert.rejects(api.shiplogReleaseFeatures(account.id, workspace, id), /Internal Shiplog/);
    const audits = (
      await admin.query(
        "SELECT actor_id,details FROM platform.shiplog_audit_events WHERE workspace_id=$1",
        [workspace]
      )
    ).rows;
    assert.equal(audits.length, 5);
    assert.ok(audits.every((event) => event.actor_id === account.id && event.details.release_id));
    await assert.rejects(
      api.pool.query("SELECT * FROM public.shiplog_releases"),
      /permission denied/
    );
  } finally {
    await admin.query("DELETE FROM public.features WHERE project_id=ANY($1::uuid[])", [
      [project, otherProject],
    ]);
    await admin.query("DELETE FROM public.projects WHERE id=ANY($1::uuid[])", [
      [project, otherProject],
    ]);
    await admin.query("DELETE FROM public.shiplog_releases WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query(
      "DELETE FROM public.shiplog_applications WHERE workspace_id=ANY($1::uuid[])",
      [[workspace, other]]
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
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
