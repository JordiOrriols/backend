import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { hasHolidayCalendar } from "../../dist/scheduler.mjs";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Integration tests require isolated Docker database URLs");

test("roadmap inclusion serializes priorities, enforces dependencies and preserves snapshots on start-date changes", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    project = randomUUID();
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const account = await api.account({
    issuer: "https://roadmap-settings-test.example",
    subject: randomUUID(),
    email: "roadmap-settings@example.com",
  });
  try {
    await admin.query("BEGIN");
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    for (const id of [workspace, other])
      await admin.query(
        "INSERT INTO public.workspaces(id,owner_id,name,plan_start_date) VALUES($1,$2,'Settings fixture','2026-02-02')",
        [id, owner]
      );
    await admin.query("INSERT INTO public.projects(id,workspace_id,name) VALUES($1,$2,'Fixture')", [
      project,
      workspace,
    ]);
    for (const [index, id] of ids.entries())
      await admin.query(
        "INSERT INTO public.features(id,project_id,name,dependency_ids) VALUES($1,$2,$3,$4)",
        [id, project, `Task ${index}`, index === 1 ? [ids[0]] : []]
      );
    await admin.query("COMMIT");
    for (const role of ["external", "viewer", "editor"]) {
      await admin.query(
        `INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,$3)
        ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role`,
        [account.id, workspace, role]
      );
      if (role !== "editor") {
        await assert.rejects(
          api.plannerToggleBacklog(account.id, workspace, ids[0]!, true),
          /edit access required/
        );
        await assert.rejects(
          api.plannerStartDate(account.id, workspace, "2026-03-02"),
          /edit access required/
        );
      }
    }
    await assert.rejects(
      api.plannerToggleBacklog(account.id, workspace, ids[1]!, true),
      /must come after/
    );
    const first = await api.plannerToggleBacklog(account.id, workspace, ids[0]!, true);
    assert.ok(first && typeof first === "object" && "priority" in first);
    assert.equal(first.priority, 1);
    assert.deepEqual(await api.plannerToggleBacklog(account.id, workspace, ids[0]!, true), first);
    const second = await api.plannerToggleBacklog(account.id, workspace, ids[1]!, true);
    assert.ok(second && typeof second === "object" && "priority" in second);
    assert.equal(second.priority, 2);
    await assert.rejects(
      api.plannerToggleBacklog(account.id, workspace, ids[0]!, false),
      /must come after/
    );
    const source = await api.plannerSource(account.id, workspace);
    assert.ok(
      source &&
        typeof source === "object" &&
        "revision" in source &&
        typeof source.revision === "string"
    );
    const proposal = await api.plannerSaveProposal(account.id, workspace, {
      name: "Before settings",
      featureIds: ids.slice(0, 2),
      expectedRevision: source.revision,
    });
    const snapshot = await api.plannerSavedProposal(account.id, workspace, proposal);
    const before = (
      await admin.query(
        "SELECT to_jsonb(f) AS feature FROM public.features f WHERE project_id=$1 ORDER BY id",
        [project]
      )
    ).rows;
    const updated = await api.plannerStartDate(account.id, workspace, "2026-03-02");
    assert.ok(
      updated && typeof updated === "object" && "startDate" in updated && "revision" in updated
    );
    assert.equal(updated.startDate, "2026-03-02");
    assert.notEqual(updated.revision, source.revision);
    assert.deepEqual(
      (
        await admin.query(
          "SELECT to_jsonb(f) AS feature FROM public.features f WHERE project_id=$1 ORDER BY id",
          [project]
        )
      ).rows,
      before
    );
    assert.deepEqual(await api.plannerSavedProposal(account.id, workspace, proposal), snapshot);
    assert.equal(hasHolidayCalendar("2026-03-02"), true);
    assert.equal(hasHolidayCalendar("2027-03-02"), true);
    assert.equal(hasHolidayCalendar("2028-03-02"), false);
    await api.plannerToggleBacklog(account.id, workspace, ids[1]!, false);
    await api.plannerToggleBacklog(account.id, workspace, ids[0]!, false);
    const concurrent = await Promise.all(
      ids.slice(2).map((id) => api.plannerToggleBacklog(account.id, workspace, id, true))
    );
    assert.deepEqual(
      concurrent
        .map((f) => {
          assert.ok(f && typeof f === "object" && "priority" in f);
          return f.priority;
        })
        .sort(),
      [1, 2]
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner')",
      [account.id, other]
    );
    await assert.rejects(
      api.plannerToggleBacklog(account.id, other, ids[0]!, true),
      /Feature unavailable/
    );
    await assert.rejects(
      api.plannerToggleBacklog(account.id, workspace, randomUUID(), true),
      /Feature unavailable/
    );
    await assert.rejects(
      api.pool.query("UPDATE public.workspaces SET plan_start_date='2026-03-02'"),
      /permission denied/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.plannerToggleBacklog(account.id, workspace, ids[0]!, true),
      /edit access required/
    );
    await assert.rejects(
      api.plannerStartDate(account.id, workspace, "2026-03-02"),
      /edit access required/
    );
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("BEGIN");
    await admin.query("DELETE FROM platform.planner_priority_proposals WHERE workspace_id=$1", [
      workspace,
    ]);
    await admin.query("DELETE FROM public.features WHERE project_id=$1", [project]);
    await admin.query("DELETE FROM public.projects WHERE id=$1", [project]);
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
