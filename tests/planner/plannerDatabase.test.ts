// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

const owner = "11111111-1111-4111-8111-111111111111";
const teammate = "22222222-2222-4222-8222-222222222222";
const stranger = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
let workspace: string;
let project: string;
async function login(id: string) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec("set role authenticated");
}
async function shareWithTeammate(access: "viewer" | "editor") {
  await db.query("select public.share_workspace($1,'member@example.com','planner',$2)", [
    workspace,
    access,
  ]);
}
beforeAll(async () => {
  db = await createMigratedDatabase([
    { id: owner, email: "owner@example.com" },
    { id: teammate, email: "member@example.com" },
    { id: stranger, email: "stranger@example.com" },
  ]);
});
beforeEach(async () => {
  await db.exec(
    "reset role; delete from public.features; delete from public.workspaces where not created_for_team"
  );
  await login(owner);
  const created = await db.query<{ id: string }>("select id from public.create_workspace('Squad')");
  workspace = created.rows[0]!.id;
  project = (
    await db.query<{ id: string }>(
      "insert into public.projects(workspace_id,name) values($1,'Launch') returning id",
      [workspace]
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await db?.close();
});

describe("Planner migration and real PostgreSQL permissions", () => {
  it("stores a default plan date and retains owner changes while denying viewer and outsider updates", async () => {
    expect(
      (
        await db.query<{ same_day: boolean }>(
          "select plan_start_date=current_date as same_day from public.workspaces where id=$1",
          [workspace]
        )
      ).rows[0]!.same_day
    ).toBe(true);
    await db.query("update public.workspaces set plan_start_date='2026-02-02' where id=$1", [
      workspace,
    ]);
    await shareWithTeammate("viewer");
    await login(teammate);
    expect(
      (
        await db.query("select plan_start_date::text from public.workspaces where id=$1", [
          workspace,
        ])
      ).rows
    ).toEqual([{ plan_start_date: "2026-02-02" }]);
    expect(
      (
        await db.query(
          "update public.workspaces set plan_start_date='2026-03-02' where id=$1 returning id",
          [workspace]
        )
      ).rows
    ).toHaveLength(0);
    await login(stranger);
    expect(
      (
        await db.query(
          "update public.workspaces set plan_start_date='2026-03-02' where id=$1 returning id",
          [workspace]
        )
      ).rows
    ).toHaveLength(0);
    await login(owner);
    expect(
      (
        await db.query("select plan_start_date::text from public.workspaces where id=$1", [
          workspace,
        ])
      ).rows
    ).toEqual([{ plan_start_date: "2026-02-02" }]);
    await expect(
      db.query("update public.workspaces set plan_start_date=null where id=$1", [workspace])
    ).rejects.toThrow(/null/);
  });
  it("defaults status to pending and lets the owner, not viewers or outsiders, change it without changing estimates", async () => {
    const feature = (
      await db.query<{ id: string; status: string }>(
        "insert into public.features(project_id,name,backend_devs,backend_weeks,in_backlog) values($1,'Feature',2,2,true) returning id,status",
        [project]
      )
    ).rows[0]!;
    expect(feature.status).toBe("pending");
    await db.query("update public.features set status='in_progress' where id=$1", [feature.id]);
    expect(
      (
        await db.query(
          "select status,backend_devs,backend_weeks,in_backlog,priority from public.features where id=$1",
          [feature.id]
        )
      ).rows[0]
    ).toEqual({
      status: "in_progress",
      backend_devs: "2",
      backend_weeks: "2",
      in_backlog: true,
      priority: 0,
    });
    await expect(
      db.query("update public.features set status='shipped' where id=$1", [feature.id])
    ).rejects.toThrow(/features_status_check/);
    await shareWithTeammate("viewer");
    await login(teammate);
    expect(
      (
        await db.query("update public.features set status='paused' where id=$1 returning id", [
          feature.id,
        ])
      ).rows
    ).toHaveLength(0);
    await login(stranger);
    expect(
      (
        await db.query("update public.features set status='paused' where id=$1 returning id", [
          feature.id,
        ])
      ).rows
    ).toHaveLength(0);
    await login(owner);
    expect(
      (await db.query("select status from public.features where id=$1", [feature.id])).rows
    ).toEqual([{ status: "in_progress" }]);
  });
  it("keeps the legacy delivered flag and status in sync for already deployed clients", async () => {
    const select = async (id: string) =>
      (await db.query("select status,delivered from public.features where id=$1", [id])).rows[0];
    const id = (
      await db.query<{ id: string }>(
        "insert into public.features(project_id,name,backend_devs,backend_weeks,delivered) values($1,'Legacy',1,1,true) returning id",
        [project]
      )
    ).rows[0]!.id;
    expect(await select(id)).toEqual({ status: "done", delivered: true });
    await db.query("update public.features set delivered=false where id=$1", [id]);
    expect(await select(id)).toEqual({ status: "pending", delivered: false });
    await db.query("update public.features set status='paused' where id=$1", [id]);
    await db.query("update public.features set delivered=false, name='Renamed' where id=$1", [id]);
    expect(await select(id)).toEqual({ status: "paused", delivered: false });
    await db.query("update public.features set status='done' where id=$1", [id]);
    expect(await select(id)).toEqual({ status: "done", delivered: true });
    await db.query("update public.features set status='in_progress', delivered=true where id=$1", [
      id,
    ]);
    expect(await select(id)).toEqual({ status: "in_progress", delivered: false });
  });
  it("rejects decimal people and weeks for every role at the database boundary", async () => {
    for (const role of ["backend", "frontend", "design", "qa"]) {
      for (const [people, weeks] of [
        [1.5, 1],
        [1, 1.5],
      ]) {
        await expect(
          db.query(
            `insert into public.features(project_id,name,${role}_devs,${role}_weeks)
           values($1,'Fractional',$2,$3)`,
            [project, people, weeks]
          )
        ).rejects.toThrow(/features_whole_estimates/);
      }
    }
    const saved = await db.query<{ id: string }>(
      "insert into public.features(project_id,name,backend_devs,backend_weeks) values($1,'Whole',1,2) returning id",
      [project]
    );
    await expect(
      db.query("update public.features set backend_weeks = 2.5 where id=$1", [saved.rows[0]!.id])
    ).rejects.toThrow(/features_whole_estimates/);
  });
  it("keeps outsiders out of both workspaces and data", async () => {
    await db.query("insert into public.features(project_id,name) values($1,'Private')", [project]);
    await login(stranger);
    expect(
      (await db.query("select * from public.workspaces where id=$1", [workspace])).rows
    ).toHaveLength(0);
    expect((await db.query("select * from public.features")).rows).toHaveLength(0);
    await expect(
      db.query("insert into public.features(project_id,name) values($1,'Bad')", [project])
    ).rejects.toThrow(/row-level security/);
  });
  it("denies anonymous access and refuses unverified workspace creation", async () => {
    await db.exec("reset role; set role anon");
    await expect(db.query("select * from public.workspaces")).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.list_workspace_shares($1)", [workspace])).rejects.toThrow(
      /permission denied/
    );
    await db.exec("reset role");
    await db.query("update auth.users set email_confirmed_at = null where id=$1", [stranger]);
    await login(stranger);
    await expect(db.query("select public.create_workspace('Bad')")).rejects.toThrow(
      /verified email/
    );
    await db.exec("reset role");
    await db.query("update auth.users set email_confirmed_at = now() where id=$1", [stranger]);
  });
  it("rejects inconsistent estimates and performs complete backlog reorder atomically", async () => {
    await expect(
      db.query("insert into public.features(project_id,name,backend_devs) values($1,'Invalid',1)", [
        project,
      ])
    ).rejects.toThrow(/check constraint/);
    const result = await db.query<{ id: string }>(
      "insert into public.features(project_id,name,in_backlog) values($1,'A',true),($1,'B',true) returning id",
      [project]
    );
    const ids = result.rows.map((row) => row.id).reverse();
    await db.query("select public.planner_reorder_features($1,$2::uuid[])", [workspace, ids]);
    expect(
      (await db.query<{ id: string }>("select id from public.features order by priority")).rows.map(
        (row) => row.id
      )
    ).toEqual(ids);
    await expect(
      db.query("select public.planner_reorder_features($1,$2::uuid[])", [workspace, [ids[0]]])
    ).rejects.toThrow(/Roadmap changed/);
    await expect(
      db.query("select public.planner_reorder_features($1,$2::uuid[])", [
        workspace,
        [ids[0], ids[0]],
      ])
    ).rejects.toThrow(/Roadmap changed/);
  });
  it("appends projects with deterministic priorities and denies outsiders backlog changes", async () => {
    const features = await db.query<{ id: string }>(
      "insert into public.features(project_id,name) values($1,'A'),($1,'B') returning id",
      [project]
    );
    for (const feature of features.rows)
      await db.query("select public.planner_toggle_backlog($1,$2,true)", [workspace, feature.id]);
    expect(
      (
        await db.query<{ priority: number }>(
          "select priority from public.features order by priority"
        )
      ).rows.map((row) => row.priority)
    ).toEqual([1, 2]);
    await login(stranger);
    await expect(
      db.query("select public.planner_toggle_backlog($1,$2,true)", [
        workspace,
        features.rows[0]!.id,
      ])
    ).rejects.toThrow(/Workspace edit access required/);
  });
});
