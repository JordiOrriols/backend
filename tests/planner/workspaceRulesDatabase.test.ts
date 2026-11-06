// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, createMigratedDatabase } from "../../testing/migratedDatabase.js";

const FEATURES_IN_PROJECTS = "20261017020000_features_belong_to_a_project.sql";
const owner = "11111111-1111-4111-8111-111111111111";
const teammate = "22222222-2222-4222-8222-222222222222";
const stranger = "33333333-3333-4333-8333-333333333333";
const accounts = [
  { id: owner, email: "owner@example.com" },
  { id: teammate, email: "teammate@example.com" },
  { id: stranger, email: "stranger@example.com" },
];
let db: PGlite | undefined;

async function login(id: string | null, role = "authenticated") {
  await db!.exec("reset role");
  await db!.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? ""]);
  await db!.exec(`set role ${role}`);
}
async function value<T>(sql: string, params: unknown[] = []) {
  return (await db!.query<{ value: T }>(sql, params)).rows[0]?.value;
}
async function rows<T>(sql: string, params: unknown[] = []) {
  return (await db!.query<T>(sql, params)).rows;
}
async function createWorkspace(name: string) {
  return (await value<string>("select (public.create_workspace($1)).id as value", [name]))!;
}
async function createTeam(name: string, workspace: string) {
  return (await value<string>("select (public.create_team($1, $2)).id as value", [
    name,
    workspace,
  ]))!;
}
async function createProject(workspace: string, name = "Launch") {
  return (await value<string>(
    "insert into public.projects(workspace_id, name) values($1, $2) returning id as value",
    [workspace, name]
  ))!;
}
async function share(workspace: string, email: string, app: string, access: string) {
  await db!.query("select public.share_workspace($1, $2, $3, $4)", [workspace, email, app, access]);
}

afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("Listing and creating workspaces", () => {
  it("lists, per app, the workspaces the account owns or was given access to", async () => {
    db = await createMigratedDatabase(accounts);
    await login(owner);
    const digital = await createWorkspace("  Digital  ");
    const pulse = await createWorkspace("pulse only");
    await createTeam("Core", digital);
    await share(digital, "teammate@example.com", "ladders", "viewer");
    await share(pulse, "teammate@example.com", "pulse", "editor");

    expect(await rows("select name, access_level from public.list_workspaces('planner')")).toEqual(
      expect.arrayContaining([
        { name: "Digital", access_level: "owner" },
        { name: "pulse only", access_level: "owner" },
      ])
    );

    await login(teammate);
    expect(
      await rows(
        "select id, access_level from public.list_workspaces('ladders') where owner_id <> auth.uid()"
      )
    ).toEqual([{ id: digital, access_level: "viewer" }]);
    // Planner opens, read-only, the workspaces of the teams the account can view.
    expect(
      await rows(
        "select id, access_level from public.list_workspaces('planner') where owner_id <> auth.uid()"
      )
    ).toEqual([{ id: digital, access_level: "viewer" }]);
    expect(
      await rows(
        "select id, access_level from public.list_workspaces('pulse') where owner_id <> auth.uid()"
      )
    ).toEqual([{ id: pulse, access_level: "editor" }]);
    await expect(db.query("select * from public.list_workspaces('mail')")).rejects.toThrow(
      /Invalid app/
    );

    await login(stranger);
    expect(await rows("select id from public.list_workspaces('planner')")).toEqual(
      expect.not.arrayContaining([{ id: digital }, { id: pulse }])
    );
  });

  it("creates workspaces only for verified accounts with a sensible name", async () => {
    db = await createMigratedDatabase(accounts);
    await login(owner);
    await expect(createWorkspace("   ")).rejects.toThrow(/between 1 and 120/);
    await expect(createWorkspace("x".repeat(121))).rejects.toThrow(/between 1 and 120/);
    const created = await rows<{ owner_id: string; created_for_team: boolean }>(
      "select owner_id, created_for_team from public.create_workspace('Squad')"
    );
    expect(created).toEqual([{ owner_id: owner, created_for_team: false }]);

    await login(null, "postgres");
    await db.query("update auth.users set email_confirmed_at = null where id = $1", [stranger]);
    await login(stranger);
    await expect(createWorkspace("Sneaky")).rejects.toThrow(/verified email/);
    await login(null, "anon");
    await expect(createWorkspace("Anonymous")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.list_workspaces('planner')")).rejects.toThrow(
      /permission denied/
    );
  });
});

describe("Teams stay in their workspace", () => {
  it("creates teams in a workspace of the caller and never moves them", async () => {
    db = await createMigratedDatabase(accounts);
    await login(owner);
    const digital = await createWorkspace("Digital");
    const other = await createWorkspace("Other");
    const team = await createTeam("Core", digital);
    expect(
      await value("select workspace_id as value from public.teams where id = $1", [team])
    ).toBe(digital);
    await expect(
      db.query("update public.teams set workspace_id = $2 where id = $1", [team, other])
    ).rejects.toThrow(/cannot move to another workspace/);
    await expect(
      db.query("select public.planner_set_workspace_teams($1, $2)", [other, [team]])
    ).rejects.toThrow(/does not exist/);

    await login(stranger);
    await expect(createTeam("Intruders", digital)).rejects.toThrow(/workspace owner/);
    await expect(
      db.query(
        "insert into public.teams(owner_id, name, workspace_id) values($1, 'Intruders', $2)",
        [stranger, digital]
      )
    ).rejects.toThrow(/workspace of their owner|row-level security/);

    // Editors of the workspace still cannot add teams: only its owner can.
    await login(owner);
    await share(digital, "teammate@example.com", "ladders", "editor");
    await login(teammate);
    await expect(createTeam("Guests", digital)).rejects.toThrow(/workspace owner/);
  });

  it("keeps a workspace with teams until its owner deletes the teams", async () => {
    db = await createMigratedDatabase(accounts);
    await login(owner);
    const digital = await createWorkspace("Digital");
    const team = await createTeam("Core", digital);
    await expect(
      db.query("delete from public.workspaces where id = $1", [digital])
    ).rejects.toThrow(/Delete the teams of this workspace first/);
    await db.query("delete from public.teams where id = $1", [team]);
    expect(
      await rows("delete from public.workspaces where id = $1 returning id", [digital])
    ).toEqual([{ id: digital }]);
  });
});

describe("Features belong to a project", () => {
  it("moves features without a project into a General project of their workspace", async () => {
    db = await createMigratedDatabase(accounts, { until: FEATURES_IN_PROJECTS });
    await login(owner);
    const loose = await createWorkspace("Loose");
    const general = await createWorkspace("Has general");
    const tidy = await createWorkspace("Tidy");
    const existingGeneral = await createProject(general, "general");
    const tidyProject = await createProject(tidy, "Funnel");
    await db.query(
      `insert into public.features(workspace_id, name, project_id) values
        ($1, 'Loose A', null), ($1, 'Loose B', null), ($2, 'Orphan', null), ($3, 'Placed', $4)`,
      [loose, general, tidy, tidyProject]
    );

    await login(null, "postgres");
    await applyMigrations(db, { from: FEATURES_IN_PROJECTS });

    expect(
      await rows(
        `select f.name as feature, p.name as project, p.workspace_id
         from public.features f join public.projects p on p.id = f.project_id order by f.name`
      )
    ).toEqual([
      { feature: "Loose A", project: "General", workspace_id: loose },
      { feature: "Loose B", project: "General", workspace_id: loose },
      { feature: "Orphan", project: "general", workspace_id: general },
      { feature: "Placed", project: "Funnel", workspace_id: tidy },
    ]);
    expect(
      await value("select count(*)::int as value from public.projects where workspace_id = $1", [
        general,
      ])
    ).toBe(1);
    expect(
      await value("select project_id as value from public.features where name = 'Orphan'")
    ).toBe(existingGeneral);
    expect(
      await rows(
        "select column_name from information_schema.columns where table_name = 'features' and column_name = 'workspace_id'"
      )
    ).toEqual([]);
  });

  it("requires a project and shares features through the project's workspace", async () => {
    db = await createMigratedDatabase(accounts);
    await login(owner);
    const workspace = await createWorkspace("Squad");
    const project = await createProject(workspace);
    expect(
      await value(
        "select is_nullable as value from information_schema.columns where table_name = 'features' and column_name = 'project_id'"
      )
    ).toBe("NO");
    const feature = (await value<string>(
      "insert into public.features(project_id, name) values($1, 'Checkout') returning id as value",
      [project]
    ))!;

    await login(stranger);
    expect(await rows("select id from public.features")).toEqual([]);
    const strangerWorkspace = await createWorkspace("Elsewhere");
    const strangerProject = await createProject(strangerWorkspace);
    await expect(
      db.query("insert into public.features(project_id, name) values($1, 'Leak')", [project])
    ).rejects.toThrow(/row-level security/);
    // Moving someone else's feature into your own project is not possible either.
    expect(
      await rows("update public.features set project_id = $2 where id = $1 returning id", [
        feature,
        strangerProject,
      ])
    ).toEqual([]);

    await login(owner);
    await share(workspace, "teammate@example.com", "planner", "viewer");
    await login(teammate);
    expect(await rows("select name from public.features")).toEqual([{ name: "Checkout" }]);
    expect(
      await rows("update public.features set name = 'Viewer' where id = $1 returning id", [feature])
    ).toEqual([]);
    await expect(
      db.query("insert into public.features(project_id, name) values($1, 'Viewer')", [project])
    ).rejects.toThrow(/row-level security/);

    await login(owner);
    await share(workspace, "teammate@example.com", "planner", "editor");
    await login(teammate);
    expect(
      await rows("update public.features set name = 'Edited' where id = $1 returning name", [
        feature,
      ])
    ).toEqual([{ name: "Edited" }]);
    // An editor cannot move a feature into a workspace they cannot edit.
    await expect(
      db.query("update public.features set project_id = $2 where id = $1", [
        feature,
        strangerProject,
      ])
    ).rejects.toThrow(/row-level security/);
  });

  it("orders the roadmap of a workspace across all its projects", async () => {
    db = await createMigratedDatabase(accounts);
    await login(owner);
    const workspace = await createWorkspace("Squad");
    const other = await createWorkspace("Other");
    const funnel = await createProject(workspace, "Funnel");
    const landings = await createProject(workspace, "Landings");
    const elsewhere = await createProject(other, "Elsewhere");
    const [a, b, c] = (
      await rows<{ id: string }>(
        `insert into public.features(project_id, name) values ($1, 'A'), ($2, 'B'), ($3, 'C')
         returning id`,
        [funnel, landings, elsewhere]
      )
    ).map((row) => row.id);

    for (const feature of [a, b])
      await db.query("select public.planner_toggle_backlog($1, $2, true)", [workspace, feature]);
    await db.query("select public.planner_toggle_backlog($1, $2, true)", [other, c]);
    expect(
      await rows("select name, priority from public.features where in_backlog order by name")
    ).toEqual([
      { name: "A", priority: 1 },
      { name: "B", priority: 2 },
      { name: "C", priority: 1 },
    ]);
    await expect(
      db.query("select public.planner_toggle_backlog($1, $2, true)", [workspace, c])
    ).rejects.toThrow(/no longer exists in this workspace/);

    await db.query("select public.planner_reorder_features($1, $2::uuid[])", [workspace, [b, a]]);
    expect(
      await rows("select name from public.features where project_id <> $1 order by priority", [
        elsewhere,
      ])
    ).toEqual([{ name: "B" }, { name: "A" }]);
    await expect(
      db.query("select public.planner_reorder_features($1, $2::uuid[])", [workspace, [a, b, c]])
    ).rejects.toThrow(/Roadmap changed/);

    await login(stranger);
    await expect(
      db.query("select public.planner_toggle_backlog($1, $2, false)", [workspace, a])
    ).rejects.toThrow(/Workspace edit access required/);
  });

  it("keeps projects and workspaces until their features have been removed", async () => {
    db = await createMigratedDatabase(accounts);
    await login(owner);
    const workspace = await createWorkspace("Squad");
    const project = await createProject(workspace);
    const empty = await createProject(workspace, "Empty");
    await db.query("insert into public.features(project_id, name) values($1, 'Checkout')", [
      project,
    ]);
    await expect(db.query("delete from public.projects where id = $1", [project])).rejects.toThrow(
      /Move or delete the features of this project first/
    );
    expect(await rows("delete from public.projects where id = $1 returning id", [empty])).toEqual([
      { id: empty },
    ]);
    await expect(
      db.query("delete from public.workspaces where id = $1", [workspace])
    ).rejects.toThrow(/Workspace is not empty/);
    await db.query("delete from public.features where project_id = $1", [project]);
    await db.query("select public.delete_workspace($1)", [workspace]);
    await login(null, "postgres");
    expect(await rows("select id from public.features")).toEqual([]);
    expect(await rows("select id from public.projects")).toEqual([]);
  });

  it("keeps a team workspace that still holds projects after its team is deleted", async () => {
    // create_team(name) gave a team its own workspace until it was dropped.
    db = await createMigratedDatabase(accounts, {
      until: "20261017070000_drop_team_era_functions.sql",
    });
    await login(owner);
    const team = (await value<string>("select (public.create_team('Solo')).id as value"))!;
    const workspace = (await value<string>(
      "select workspace_id as value from public.teams where id = $1",
      [team]
    ))!;
    await createProject(workspace);
    await db.query("delete from public.teams where id = $1", [team]);
    expect(await rows("select id from public.workspaces where id = $1", [workspace])).toEqual([
      { id: workspace },
    ]);

    const second = (await value<string>("select (public.create_team('Brief')).id as value"))!;
    const secondWorkspace = (await value<string>(
      "select workspace_id as value from public.teams where id = $1",
      [second]
    ))!;
    await db.query("delete from public.teams where id = $1", [second]);
    expect(await rows("select id from public.workspaces where id = $1", [secondWorkspace])).toEqual(
      []
    );
  });
});
