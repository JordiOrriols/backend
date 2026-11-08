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

test("official ordering is atomic, editor-scoped, revision-checked and preserves snapshots and nonpriority fields", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    project = randomUUID();
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const account = await api.account({
    issuer: "https://priorities-test.example",
    subject: randomUUID(),
    email: "priorities-test@example.com",
  });
  const order = [ids[0]!, ids[1]!, ids[3]!, ids[2]!, ids[4]!];
  try {
    await admin.query("BEGIN");
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name,plan_start_date) VALUES($1,$2,'Local priorities','2026-02-02')",
      [workspace, owner]
    );
    await admin.query(
      "INSERT INTO public.projects(id,workspace_id,name) VALUES($1,$2,'Local priorities')",
      [project, workspace]
    );
    for (const [index, id] of ids.entries())
      await admin.query(
        `INSERT INTO public.features(id,project_id,name,description,in_backlog,priority,status,dependency_ids)
        VALUES($1,$2,$3,'Private description',$4,$5,$6,$7)`,
        [
          id,
          project,
          `Local feature ${index}`,
          index < 5,
          index + 1,
          index === 0 ? "done" : index === 1 ? "in_progress" : "pending",
          index === 4 ? [ids[2]] : [],
        ]
      );
    await admin.query("COMMIT");
    const original = (
      await admin.query(
        "SELECT to_jsonb(f) AS feature FROM public.features f WHERE project_id=$1 ORDER BY id",
        [project]
      )
    ).rows;
    const revision = async () => {
      const source = await api.plannerSource(account.id, workspace);
      assert.ok(
        source &&
          typeof source === "object" &&
          "revision" in source &&
          typeof source.revision === "string"
      );
      return source.revision;
    };
    const input = { featureIds: order, expectedRevision: "0".repeat(32) };
    await assert.rejects(
      api.plannerApplyPriorities(account.id, workspace, input),
      /edit access required/
    );
    for (const role of ["external", "viewer", "editor"]) {
      await admin.query(
        `INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,$3)
        ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role`,
        [account.id, workspace, role]
      );
      input.expectedRevision = await revision();
      if (role !== "editor")
        await assert.rejects(
          api.plannerApplyPriorities(account.id, workspace, input),
          /edit access required/
        );
    }
    for (const featureIds of [
      [ids[1]!, ids[0]!, ...order.slice(2)],
      [ids[0]!, ids[1]!, ids[4]!, ids[2]!, ids[3]!],
      order.slice(1),
      [...order.slice(0, 4), ids[5]!],
    ])
      await assert.rejects(
        api.plannerApplyPriorities(account.id, workspace, { ...input, featureIds })
      );
    await assert.rejects(
      api.plannerApplyPriorities(account.id, workspace, {
        ...input,
        expectedRevision: "0".repeat(32),
      }),
      /Roadmap changed/
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT to_jsonb(f) AS feature FROM public.features f WHERE project_id=$1 ORDER BY id",
          [project]
        )
      ).rows,
      original
    );
    const snapshotId = await api.plannerSaveProposal(account.id, workspace, {
      ...input,
      name: "Preserved snapshot",
    });
    const snapshot = await api.plannerSavedProposal(account.id, workspace, snapshotId);
    const applied = await api.plannerApplyPriorities(account.id, workspace, input);
    assert.ok(
      applied &&
        typeof applied === "object" &&
        "features" in applied &&
        Array.isArray(applied.features)
    );
    assert.deepEqual(
      applied.features.map((f) => f.id),
      order
    );
    assert.equal((await revision()) === input.expectedRevision, false);
    const changed = (
      await admin.query(
        "SELECT to_jsonb(f) AS feature FROM public.features f WHERE project_id=$1 ORDER BY id",
        [project]
      )
    ).rows;
    assert.deepEqual(
      changed.map(({ feature }) => {
        const { priority, ...rest } = feature;
        return rest;
      }),
      original.map(({ feature }) => {
        const { priority, ...rest } = feature;
        return rest;
      })
    );
    assert.deepEqual(
      changed.find(({ feature }) => feature.id === ids[5]),
      original.find(({ feature }) => feature.id === ids[5])
    );
    assert.deepEqual(await api.plannerSavedProposal(account.id, workspace, snapshotId), snapshot);
    await assert.rejects(
      api.plannerApplyPriorities(account.id, workspace, input),
      /Roadmap changed/
    );
    const currentRevision = await revision();
    const concurrent = await Promise.allSettled([
      api.plannerApplyPriorities(account.id, workspace, {
        featureIds: ids.slice(0, 5),
        expectedRevision: currentRevision,
      }),
      api.plannerApplyPriorities(account.id, workspace, {
        featureIds: [ids[0]!, ids[1]!, ids[2]!, ids[4]!, ids[3]!],
        expectedRevision: currentRevision,
      }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejection = concurrent.find((result) => result.status === "rejected");
    assert.ok(rejection && rejection.status === "rejected");
    assert.match(String(rejection.reason), /Roadmap changed/);
    await admin.query("UPDATE platform.grants SET role='owner' WHERE user_id=$1", [account.id]);
    await api.plannerApplyPriorities(account.id, workspace, {
      featureIds: order,
      expectedRevision: await revision(),
    });
    await assert.rejects(
      api.plannerApplyPriorities(account.id, randomUUID(), input),
      /edit access required/
    );
    await assert.rejects(
      api.pool.query("UPDATE public.features SET priority=1"),
      /permission denied/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.plannerApplyPriorities(account.id, workspace, input),
      /edit access required/
    );
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("BEGIN");
    await admin.query("DELETE FROM platform.planner_priority_proposals WHERE workspace_id=$1", [
      workspace,
    ]);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.features WHERE project_id=$1", [project]);
    await admin.query("DELETE FROM public.projects WHERE id=$1", [project]);
    await admin.query("DELETE FROM public.workspaces WHERE id=$1", [workspace]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.query("COMMIT");
    await admin.end();
    await api.pool.end();
  }
});
