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

test("project management enforces internal grants, workspace scope and nonempty deletion protection", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID();
  const account = await api.account({
    issuer: "https://projects-test.example",
    subject: randomUUID(),
    email: "projects-test@example.com",
  });
  try {
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    for (const id of [workspace, other])
      await admin.query(
        "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$2,'Local project test')",
        [id, owner]
      );
    await assert.rejects(
      api.plannerProjects(account.id, workspace),
      /Internal Planner access required/
    );
    for (const role of ["external", "viewer", "editor"]) {
      await admin.query(
        `INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,$3)
        ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role`,
        [account.id, workspace, role]
      );
      if (role === "external")
        await assert.rejects(
          api.plannerProjects(account.id, workspace),
          /Internal Planner access required/
        );
      else assert.deepEqual(await api.plannerProjects(account.id, workspace), []);
      if (role !== "editor")
        await assert.rejects(
          api.plannerProject(account.id, workspace, "create", null, "Denied"),
          /Internal Planner access required/
        );
    }
    const created = await api.plannerProject(account.id, workspace, "create", null, " Project ");
    assert.ok(
      created && typeof created === "object" && "id" in created && typeof created.id === "string"
    );
    const project = { id: created.id, workspace_id: workspace, name: "Project", in_use: false };
    assert.deepEqual(created, project);
    await assert.rejects(
      api.plannerProject(account.id, workspace, "create", null, ""),
      /check constraint/
    );
    await admin.query("INSERT INTO public.features(project_id,name) VALUES($1,'Backlog feature')", [
      project.id,
    ]);
    assert.deepEqual(await api.plannerProjects(account.id, workspace), [
      { ...project, in_use: true },
    ]);
    await assert.rejects(
      api.plannerProject(account.id, workspace, "delete", project.id, null),
      /Move or delete/
    );
    assert.deepEqual(
      await api.plannerProject(account.id, workspace, "rename", project.id, "Renamed"),
      {
        ...project,
        name: "Renamed",
        in_use: true,
      }
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner')",
      [account.id, other]
    );
    for (const action of ["rename", "delete"] as const)
      await assert.rejects(
        api.plannerProject(account.id, other, action, project.id, "Denied"),
        /Project unavailable/
      );
    await assert.rejects(
      api.pool.query("UPDATE public.projects SET name='Direct write'"),
      /permission denied/
    );
    await admin.query("DELETE FROM public.features WHERE project_id=$1", [project.id]);
    await api.plannerProject(account.id, workspace, "delete", project.id, null);
    assert.deepEqual(await api.plannerProjects(account.id, workspace), []);
    await assert.rejects(
      api.plannerProject(account.id, workspace, "delete", project.id, null),
      /Project unavailable/
    );
    await api.plannerProject(account.id, other, "create", null, "Owner project");
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.plannerProjects(account.id, other),
      /Internal Planner access required/
    );
  } finally {
    await admin.query("BEGIN");
    await admin.query(
      "DELETE FROM public.features WHERE project_id IN (SELECT id FROM public.projects WHERE workspace_id=ANY($1::uuid[]))",
      [[workspace, other]]
    );
    await admin.query("DELETE FROM public.projects WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
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
