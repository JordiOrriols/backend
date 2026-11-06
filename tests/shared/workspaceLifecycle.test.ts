// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

const owner = "11111111-1111-4111-8111-111111111111";
const outsider = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
async function login(id: string | null) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  await db.exec(`set role ${id ? "authenticated" : "anon"}`);
}
async function workspace() {
  await login(owner);
  return (await db.query<{ id: string }>("select id from public.create_workspace('Temporary')"))
    .rows[0]!.id;
}
beforeAll(async () => {
  db = await createMigratedDatabase([
    { id: owner, email: "owner@example.com" },
    { id: outsider, email: "other@example.com" },
  ]);
});
afterAll(async () => db?.close());

it("does not create a team or workspace when a new account signs up", async () => {
  await db.exec("reset role");
  const id = "33333333-3333-4333-8333-333333333333";
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'new@example.com',now())",
    [id]
  );
  expect((await db.query("select id from public.teams where owner_id=$1", [id])).rows).toEqual([]);
  await login(id);
  for (const app of ["ladders", "planner", "pulse", "shiplog", "agents"])
    expect((await db.query("select id from public.list_workspaces($1)", [app])).rows).toEqual([]);
});

it("lets only the owner delete an empty workspace", async () => {
  const id = await workspace();
  await db.query("select public.share_workspace($1,'other@example.com','planner','editor')", [id]);
  await login(outsider);
  await expect(db.query("select public.delete_workspace($1)", [id])).rejects.toThrow(
    "Only the workspace owner"
  );
  await login(null);
  await expect(db.query("select public.delete_workspace($1)", [id])).rejects.toThrow(
    "permission denied"
  );
  await login(owner);
  await db.query("select public.delete_workspace($1)", [id]);
  expect((await db.query("select id from public.workspaces where id=$1", [id])).rows).toEqual([]);
});

it("removes empty default teams and projects along with their workspace", async () => {
  const id = await workspace();
  await db.exec("reset role");
  await db.query(
    "insert into public.teams(owner_id,name,is_default,workspace_id) values($1,'Empty',false,$2)",
    [owner, id]
  );
  await db.query("insert into public.projects(workspace_id,name) values($1,'Empty')", [id]);
  await login(owner);
  await db.query("select public.delete_workspace($1)", [id]);
  expect((await db.query("select id from public.workspaces where id=$1", [id])).rows).toEqual([]);
  await db.exec("reset role");
  expect(
    (await db.query("select id from public.projects where workspace_id=$1", [id])).rows
  ).toEqual([]);
  const legacy = (
    await db.query<{ workspace_id: string }>(
      "select workspace_id from public.teams where owner_id=$1 and is_default",
      [owner]
    )
  ).rows[0]!.workspace_id;
  await login(owner);
  await expect(
    db.query("delete from public.teams where workspace_id=$1", [legacy])
  ).rejects.toThrow("default team cannot be deleted");
  await db.query("select public.delete_workspace($1)", [legacy]);
  expect((await db.query("select id from public.workspaces where id=$1", [legacy])).rows).toEqual(
    []
  );
});

it("rejects content in another app even for the owner", async () => {
  const id = await workspace();
  await db.query("select public.agents_create_task($1,'Keep','Instructions')", [id]);
  await expect(db.query("select public.delete_workspace($1)", [id])).rejects.toThrow(
    "Workspace is not empty"
  );
  expect((await db.query("select id from public.workspaces where id=$1", [id])).rows).toHaveLength(
    1
  );
});

it("does not count teams or projects as empty when they have members or features", async () => {
  const id = await workspace();
  await db.exec("reset role");
  const project = (
    await db.query<{ id: string }>(
      "insert into public.projects(workspace_id,name) values($1,'Plan') returning id",
      [id]
    )
  ).rows[0]!.id;
  await db.query("insert into public.features(project_id,name) values($1,'Keep')", [project]);
  await login(owner);
  await expect(db.query("select public.delete_workspace($1)", [id])).rejects.toThrow(
    "Workspace is not empty"
  );
});

it.each([
  [
    "Ladders member",
    "insert into public.teams(owner_id,name,workspace_id) values($2,'Team',$1); insert into public.members(team_id,name,role) select id,'Person','Engineer' from public.teams where workspace_id=$1",
  ],
  ["Pulse survey", "insert into public.pulse_surveys(workspace_id,title) values($1,'Survey')"],
  [
    "Pulse retrospective",
    "insert into public.pulse_retros(workspace_id,title,template) values($1,'Retro','open')",
  ],
  ["Pulse action", "insert into public.pulse_actions(workspace_id,title) values($1,'Action')"],
  [
    "Shiplog application",
    "insert into public.shiplog_applications(workspace_id,name) values($1,'App')",
  ],
  [
    "Shiplog audit history",
    "insert into public.shiplog_audit_events(workspace_id,event) values($1,'Keep history')",
  ],
  [
    "Planner marker",
    "insert into public.roadmap_markers(workspace_id,name,date) values($1,'Milestone',current_date)",
  ],
])("protects %s through the RPC and direct REST deletion", async (_name, sql) => {
  const id = await workspace();
  await db.exec("reset role");
  for (const statement of sql.split(";")) {
    const params = statement.includes("$2") ? [id, owner] : [id];
    await db.query(statement, params);
  }
  await login(owner);
  await expect(db.query("select public.delete_workspace($1)", [id])).rejects.toThrow(
    "Workspace is not empty"
  );
  await expect(db.query("delete from public.workspaces where id=$1", [id])).rejects.toThrow();
  expect((await db.query("select id from public.workspaces where id=$1", [id])).rows).toHaveLength(
    1
  );
});
