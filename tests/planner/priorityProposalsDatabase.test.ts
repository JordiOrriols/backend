// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

const owner = "11111111-1111-4111-8111-111111111111";
const visitor = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
let workspace: string;
let project: string;
let otherProject: string;
let ids: string[];
let token: string;
type Source = { revision: string; features: { id: string; name: string; priority: number }[] };
async function login(id: string | null, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  await db.exec(`set role ${role}`);
}
async function value<T>(sql: string, params: unknown[] = []) {
  return (await db.query<{ value: T }>(sql, params)).rows[0]!.value;
}
async function source() {
  await login(null, "service_role");
  return value<Source>("select public.planner_roadmap_source($1) as value", [token]);
}
async function dependencies(id: string, parents: (string | null)[]) {
  await db.query("update public.features set dependency_ids=$2 where id=$1", [id, parents]);
}
async function save(name: string, order: string[], revision: string | null) {
  return value<string>("select public.planner_save_priority_proposal($1,$2,$3,$4) as value", [
    token,
    name,
    order,
    revision,
  ]);
}
beforeEach(async () => {
  db = await createMigratedDatabase([
    { id: owner, email: "owner@example.com" },
    { id: visitor, email: "visitor@example.com" },
  ]);
  await login(owner);
  workspace = await value("select (public.create_workspace('Priorities')).id as value");
  project = await value(
    "insert into public.projects(workspace_id,name) values($1,'Core') returning id as value",
    [workspace]
  );
  otherProject = await value(
    "insert into public.projects(workspace_id,name) values($1,'Web') returning id as value",
    [workspace]
  );
  ids = [];
  for (let index = 0; index < 4; index++)
    ids.push(
      await value(
        "insert into public.features(project_id,name,in_backlog,priority,backend_devs,backend_weeks) values($1,$2,true,$3,1,1) returning id as value",
        [index === 3 ? otherProject : project, ["A", "B", "C", "D"][index], index + 1]
      )
    );
  token = await value("select public.planner_roadmap_share($1,true) as value", [workspace]);
});
afterEach(async () => {
  await db?.close();
});

describe("feature dependencies", () => {
  it("validates dense acyclic graphs without enumerating every possible path", async () => {
    await db.query(
      "insert into public.features(project_id,name,priority) select $1,'Dense ' || n,n from generate_series(5,24) n",
      [project]
    );
    await db.query("update public.features set in_backlog=false");
    await db.query(
      "update public.features f set dependency_ids=coalesce((select array_agg(parent.id) from public.features parent where parent.priority<f.priority),'{}')"
    );
    const last = await value<string>("select id as value from public.features where priority=24");
    await expect(dependencies(ids[0]!, [last])).rejects.toThrow(/cycle/);
  });
  it("supports multiple cross-project prerequisites and rejects direct and RPC invalid orders atomically", async () => {
    await dependencies(ids[1]!, [ids[0]!]);
    await dependencies(ids[2]!, [ids[0]!, ids[1]!]);
    await dependencies(ids[3]!, [ids[0]!]);
    await expect(
      db.query("update public.features set priority=0 where id=$1", [ids[1]])
    ).rejects.toThrow(/must come after/);
    await expect(
      db.query("select public.planner_reorder_features($1,$2)", [
        workspace,
        [ids[1], ids[0], ids[2], ids[3]],
      ])
    ).rejects.toThrow(/must come after/);
    await db.query("select public.planner_reorder_features($1,$2)", [
      workspace,
      [ids[0], ids[1], ids[3], ids[2]],
    ]);
    expect((await source()).features.map((feature) => feature.id)).toEqual([
      ids[0],
      ids[1],
      ids[3],
      ids[2],
    ]);
  });
  it("rejects self, missing, duplicate, null, cross-workspace and cyclic dependencies", async () => {
    const foreignWorkspace = await value<string>(
      "select (public.create_workspace('Other')).id as value"
    );
    const foreignProject = await value<string>(
      "insert into public.projects(workspace_id,name) values($1,'Other') returning id as value",
      [foreignWorkspace]
    );
    const foreign = await value<string>(
      "insert into public.features(project_id,name) values($1,'Foreign') returning id as value",
      [foreignProject]
    );
    for (const parents of [
      [ids[1]!],
      ["99999999-9999-4999-8999-999999999999"],
      [ids[0]!, ids[0]!],
      [null],
      [foreign],
    ])
      await expect(dependencies(ids[1]!, parents)).rejects.toThrow(/Invalid dependencies/);
    await db.query("update public.features set in_backlog=false");
    await dependencies(ids[1]!, [ids[0]!]);
    await dependencies(ids[2]!, [ids[1]!]);
    await expect(dependencies(ids[0]!, [ids[2]!])).rejects.toThrow(/cycle/);
  });
  it("protects prerequisite removal, feature/project deletion and workspace identity", async () => {
    await dependencies(ids[3]!, [ids[0]!]);
    await expect(
      db.query("update public.features set in_backlog=false where id=$1", [ids[0]])
    ).rejects.toThrow(/must come after/);
    await expect(db.query("delete from public.features where id=$1", [ids[0]])).rejects.toThrow(
      /Invalid dependencies/
    );
    await expect(db.query("delete from public.projects where id=$1", [project])).rejects.toThrow(
      /Move or delete the features/
    );
    const foreign = await value<string>("select (public.create_workspace('Other')).id as value");
    await expect(
      db.query("update public.projects set workspace_id=$2 where id=$1", [project, foreign])
    ).rejects.toThrow(/cannot move/);
    await dependencies(ids[3]!, []);
    await db.query("delete from public.features where project_id=$1", [project]);
    await db.query("delete from public.projects where id=$1", [project]);
  });
});

describe("public priority proposals", () => {
  it("allows a signed-in non-member to save multiple snapshots without changing official priorities", async () => {
    const live = await source();
    await login(visitor);
    const order = [ids[3]!, ids[0]!, ids[1]!, ids[2]!];
    const first = await save("  Alternative  ", order, live.revision);
    const second = await save("Baseline", ids, live.revision);
    expect((await source()).features.map((feature) => feature.id)).toEqual(ids);
    const snapshot = await value<Source>(
      "select public.planner_saved_proposal_source($1,$2) as value",
      [token, first]
    );
    expect(snapshot.features.map((feature) => feature.id)).toEqual(order);
    await login(null, "anon");
    const listed = (
      await db.query<{ id: string; name: string; created_at: string }>(
        "select * from public.planner_list_priority_proposals($1)",
        [token]
      )
    ).rows;
    expect(listed.map((proposal) => proposal.name).sort()).toEqual(["Alternative", "Baseline"]);
    expect(listed.map((proposal) => proposal.id)).toEqual(expect.arrayContaining([first, second]));
    expect(Object.keys(listed[0]!).sort()).toEqual(["created_at", "id", "name"]);
    for (const role of ["anon", "authenticated"]) {
      await login(visitor, role);
      await expect(db.query("select * from public.planner_priority_proposals")).rejects.toThrow(
        /permission denied/
      );
      await expect(
        db.query("select public.planner_saved_proposal_source($1,$2)", [token, first])
      ).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.planner_roadmap_source($1)", [token])).rejects.toThrow(
        /permission denied/
      );
    }
  });
  it("requires verification, valid names, a full permutation and a matching live revision", async () => {
    const live = await source();
    await login(null, "anon");
    await expect(save("Test", ids, live.revision)).rejects.toThrow(/permission denied/);
    await login(visitor);
    for (const name of ["", " ", "x".repeat(121)])
      await expect(save(name, ids, live.revision)).rejects.toThrow(/between 1 and 120/);
    for (const order of [ids.slice(1), [ids[0]!, ids[0]!, ids[2]!, ids[3]!]])
      await expect(save("Test", order, live.revision)).rejects.toThrow(/Roadmap changed/);
    await expect(save("Test", ids, null)).rejects.toThrow(/Reload/);
    await login(owner);
    await db.query("update public.features set name='Changed' where id=$1", [ids[0]]);
    await login(visitor);
    await expect(save("Stale", ids, live.revision)).rejects.toThrow(/Roadmap changed/);
    await db.exec("reset role");
    await db.query("update auth.users set email_confirmed_at=null where id=$1", [visitor]);
    await login(visitor);
    await expect(save("Unverified", ids, live.revision)).rejects.toThrow(/verified email/);
  });
  it("locks the whole completed/in-progress prefix but accepts pending and paused suffix moves", async () => {
    await db.query("update public.features set status='in_progress' where id=$1", [ids[1]]);
    await db.query("update public.features set status='paused' where id=$1", [ids[3]]);
    const live = await source();
    await login(visitor);
    for (const order of [
      [ids[1]!, ids[0]!, ids[2]!, ids[3]!],
      [ids[2]!, ids[0]!, ids[1]!, ids[3]!],
    ])
      await expect(save("Locked", order, live.revision)).rejects.toThrow(/Only pending or paused/);
    await save("Paused first", [ids[0]!, ids[1]!, ids[3]!, ids[2]!], live.revision);
    await login(owner);
    await dependencies(ids[3]!, [ids[2]!]);
    const next = await source();
    await login(visitor);
    await expect(
      save("Invalid dependency", [ids[0]!, ids[1]!, ids[3]!, ids[2]!], next.revision)
    ).rejects.toThrow(/must come after its dependency/);
  });
  it("preserves historical inputs, scopes recovery to the token and clears proposals on revocation", async () => {
    const live = await source();
    await login(visitor);
    const proposal = await save("Snapshot", ids, live.revision);
    await login(owner);
    await db.query("update public.features set name='Changed', backend_weeks=3 where id=$1", [
      ids[0],
    ]);
    const otherWorkspace = await value<string>(
      "select (public.create_workspace('Other')).id as value"
    );
    const otherToken = await value<string>(
      "select public.planner_roadmap_share($1,true) as value",
      [otherWorkspace]
    );
    await login(null, "service_role");
    const snapshot = await value<Source>(
      "select public.planner_saved_proposal_source($1,$2) as value",
      [token, proposal]
    );
    expect(snapshot.features[0]!.name).toBe("A");
    expect(snapshot.revision).toBe(live.revision);
    await expect(
      db.query("select public.planner_saved_proposal_source($1,$2)", [otherToken, proposal])
    ).rejects.toThrow(/unavailable/);
    await login(owner);
    await db.query("delete from public.features");
    await expect(db.query("select public.delete_workspace($1)", [workspace])).rejects.toThrow(
      /content/
    );
    await db.query("select public.planner_roadmap_share($1,false)", [workspace]);
    await db.query("select public.delete_workspace($1)", [workspace]);
    await login(null, "anon");
    await expect(
      db.query("select public.planner_list_priority_proposals($1)", [token])
    ).rejects.toThrow(/unavailable/);
  });
});
