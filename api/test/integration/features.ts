import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { featureInput } from "../../src/planner-input.js";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Integration tests require isolated Docker database URLs");

test("feature CRUD keeps private fields internal and reuses workspace dependency constraints atomically", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID();
  const project = randomUUID(),
    secondProject = randomUUID(),
    foreignProject = randomUUID();
  const account = await api.account({
    issuer: "https://features-test.example",
    subject: randomUUID(),
    email: "features-test@example.com",
  });
  const input = featureInput({
    name: " Task ",
    description: "Private description",
    project_id: project,
    status: "pending",
    dependency_ids: [],
    backend_devs: 1,
    backend_weeks: 2,
    frontend_devs: 0,
    frontend_weeks: 0,
    design_devs: 0,
    design_weeks: 0,
    qa_devs: 0,
    qa_weeks: 0,
  });
  const list = () => api.plannerFeatures(account.id, workspace);
  async function create(name: string) {
    const result = await api.plannerFeature(account.id, workspace, "create", null, {
      ...input,
      name,
    });
    assert.ok(
      result && typeof result === "object" && "id" in result && typeof result.id === "string"
    );
    return { id: result.id };
  }
  try {
    await admin.query("BEGIN");
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    for (const id of [workspace, other])
      await admin.query(
        "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$2,'Local feature test')",
        [id, owner]
      );
    for (const [id, scope] of [
      [project, workspace],
      [secondProject, workspace],
      [foreignProject, other],
    ])
      await admin.query("INSERT INTO public.projects(id,workspace_id,name) VALUES($1,$2,$3)", [
        id,
        scope,
        `Local feature project ${id}`,
      ]);
    await admin.query("COMMIT");
    await assert.rejects(list(), /Internal Planner access required/);
    for (const role of ["external", "viewer", "editor"]) {
      await admin.query(
        `INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,$3)
        ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role`,
        [account.id, workspace, role]
      );
      if (role === "external") await assert.rejects(list(), /Internal Planner access required/);
      else assert.deepEqual(await list(), []);
      if (role !== "editor") await assert.rejects(create("Denied"), /edit access required/);
    }
    const first = await create("First"),
      second = await create("Second");
    const unchanged = await list();
    assert.ok(Array.isArray(unchanged));
    assert.deepEqual(
      unchanged.find((f) => f.id === first.id),
      { ...input, name: "First", ...first, in_backlog: false, priority: 0 }
    );
    await api.plannerFeature(account.id, workspace, "save", second.id, {
      ...input,
      name: "Second",
      dependency_ids: [first.id],
    });
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "save", first.id, {
        ...input,
        dependency_ids: [second.id],
      }),
      /cycle/
    );
    for (const dependencies of [[first.id], [randomUUID()], [second.id, second.id]])
      await assert.rejects(
        api.plannerFeature(account.id, workspace, "save", first.id, {
          ...input,
          dependency_ids: dependencies,
        }),
        /Invalid dependencies|cycle/
      );
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "delete", first.id, null),
      /Invalid dependencies/
    );
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "save", first.id, {
        ...input,
        project_id: foreignProject,
      }),
      /Project unavailable/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner')",
      [account.id, other]
    );
    const foreign = await api.plannerFeature(account.id, other, "create", null, {
      ...input,
      project_id: foreignProject,
    });
    assert.ok(
      foreign && typeof foreign === "object" && "id" in foreign && typeof foreign.id === "string"
    );
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "save", first.id, {
        ...input,
        dependency_ids: [foreign.id],
      }),
      /Invalid dependencies/
    );
    await assert.rejects(
      api.plannerFeature(account.id, other, "save", first.id, input),
      /Feature unavailable/
    );
    await assert.rejects(
      api.plannerFeature(account.id, other, "delete", first.id, null),
      /Feature unavailable/
    );
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "save", randomUUID(), input),
      /Feature unavailable/
    );
    await admin.query(
      "UPDATE public.features SET in_backlog=true,priority=CASE WHEN id=$1 THEN 1 ELSE 2 END WHERE project_id=$2",
      [first.id, project]
    );
    const third = await create("Later prerequisite");
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "save", first.id, {
        ...input,
        dependency_ids: [third.id],
      }),
      /must come after its dependency/
    );
    await admin.query("UPDATE public.features SET in_backlog=true,priority=3 WHERE id=$1", [
      third.id,
    ]);
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "save", first.id, {
        ...input,
        dependency_ids: [third.id],
      }),
      /must come after its dependency/
    );
    const source = await api.plannerSource(account.id, workspace);
    assert.ok(
      source &&
        typeof source === "object" &&
        "revision" in source &&
        typeof source.revision === "string"
    );
    const proposal = await api.plannerSaveProposal(account.id, workspace, {
      name: "Before task edits",
      featureIds: [first.id, second.id, third.id],
      expectedRevision: source.revision,
    });
    const snapshot = await api.plannerSavedProposal(account.id, workspace, proposal);
    const saved = await api.plannerFeature(account.id, workspace, "save", first.id, {
      ...input,
      name: "Renamed",
      project_id: secondProject,
      status: "in_progress",
      backend_weeks: 3,
    });
    assert.deepEqual(saved, {
      ...input,
      name: "Renamed",
      project_id: secondProject,
      status: "in_progress",
      backend_weeks: 3,
      ...first,
      in_backlog: true,
      priority: 1,
    });
    assert.deepEqual(await api.plannerSavedProposal(account.id, workspace, proposal), snapshot);
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "save", first.id, { ...input, backend_devs: 1.5 }),
      /check constraint/
    );
    await assert.rejects(
      api.plannerFeature(account.id, workspace, "save", first.id, {
        ...input,
        dependency_ids: [second.id],
      }),
      /cycle/
    );
    const afterRejection = await list();
    assert.ok(Array.isArray(afterRejection));
    assert.deepEqual(
      afterRejection.find((f) => f.id === first.id),
      saved
    );
    await assert.rejects(
      api.pool.query("SELECT description FROM public.features"),
      /permission denied/
    );
    await assert.rejects(api.pool.query("DELETE FROM public.features"), /permission denied/);
    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND workspace_id=$2",
      [account.id, workspace]
    );
    await api.plannerFeature(account.id, workspace, "delete", second.id, null);
    await api.plannerFeature(account.id, workspace, "delete", first.id, null);
    await api.plannerFeature(account.id, workspace, "delete", third.id, null);
    assert.deepEqual(await list(), []);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(list(), /Internal Planner access required/);
    await assert.rejects(create("Revoked"), /edit access required/);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("BEGIN");
    await admin.query("DELETE FROM platform.planner_priority_proposals WHERE workspace_id=$1", [
      workspace,
    ]);
    await admin.query("DELETE FROM public.features WHERE project_id=ANY($1::uuid[])", [
      [project, secondProject, foreignProject],
    ]);
    await admin.query("DELETE FROM public.projects WHERE id=ANY($1::uuid[])", [
      [project, secondProject, foreignProject],
    ]);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.query("COMMIT");
    await admin.end();
    await api.pool.end();
  }
});
