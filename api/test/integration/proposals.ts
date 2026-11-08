import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { buildPublicRoadmap } from "../../dist/scheduler.mjs";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Integration tests require isolated Docker database URLs");

test("workspace-scoped proposals reuse priority validation, persist snapshots and never change official records", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    project = randomUUID();
  const features = Array.from({ length: 5 }, () => randomUUID());
  const account = await api.account({
    issuer: "https://proposal-test.example",
    subject: randomUUID(),
    email: "proposal-test@example.com",
  });
  try {
    await admin.query("BEGIN");
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name,plan_start_date) VALUES($1,$2,'Proposal integration','2026-02-02')",
      [workspace, owner]
    );
    await admin.query(
      "INSERT INTO public.projects(id,workspace_id,name) VALUES($1,$2,'Proposal project')",
      [project, workspace]
    );
    for (const [index, id] of features.entries())
      await admin.query(
        `INSERT INTO public.features(id,project_id,name,in_backlog,priority,status,dependency_ids)
        VALUES($1,$2,$3,true,$4,$5,$6)`,
        [
          id,
          project,
          `Proposal feature ${index}`,
          index + 1,
          index === 0 ? "done" : index === 1 ? "in_progress" : "pending",
          index === 4 ? [features[2]] : [],
        ]
      );
    await admin.query("COMMIT");
    const order = [features[0]!, features[1]!, features[3]!, features[2]!, features[4]!];
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
    await assert.rejects(api.plannerProposals(account.id, workspace), /Workspace access required/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'external')",
      [account.id, workspace]
    );
    const input = { featureIds: order, expectedRevision: await revision() };
    const official = await api.plannerSource(account.id, workspace);
    const preview = await api.plannerPreview(account.id, workspace, input);
    assert.ok(
      preview &&
        typeof preview === "object" &&
        "features" in preview &&
        Array.isArray(preview.features)
    );
    assert.deepEqual(
      preview.features.map((f) => f.id),
      order
    );
    assert.deepEqual(await api.plannerProposals(account.id, workspace), []);
    assert.deepEqual(await api.plannerSource(account.id, workspace), official);
    for (const featureIds of [
      [features[1]!, features[0]!, ...order.slice(2)],
      [features[0]!, features[1]!, features[4]!, features[3]!, features[2]!],
      order.slice(1),
      [...order.slice(0, 4), order[0]!],
    ])
      await assert.rejects(api.plannerPreview(account.id, workspace, { ...input, featureIds }));
    await assert.rejects(
      api.plannerPreview(account.id, workspace, { ...input, expectedRevision: "0".repeat(32) }),
      /Roadmap changed/
    );
    await assert.rejects(
      api.plannerSaveProposal(account.id, workspace, { ...input, name: " " }),
      /Proposal names/
    );
    const id = await api.plannerSaveProposal(account.id, workspace, {
      ...input,
      name: "Alternative A",
    });
    const second = await api.plannerSaveProposal(account.id, workspace, {
      ...input,
      featureIds: features,
      name: "Alternative B",
    });
    assert.notEqual(second, id);
    const listed = await api.plannerProposals(account.id, workspace);
    assert.equal(listed.length, 2);
    assert.deepEqual(Object.keys(listed[0]!).sort(), ["created_at", "id", "name"]);
    assert.ok(!Number.isNaN(Date.parse(listed[0]!.created_at)));
    assert.deepEqual(
      buildPublicRoadmap(await api.plannerSavedProposal(account.id, workspace, id)),
      buildPublicRoadmap(preview)
    );
    await assert.rejects(
      api.pool.query("SELECT source FROM platform.planner_priority_proposals"),
      /permission denied/
    );
    await assert.rejects(
      api.plannerSavedProposal(account.id, workspace, randomUUID()),
      /Priority proposal unavailable/
    );
    await assert.rejects(
      api.plannerSavedProposal(account.id, randomUUID(), id),
      /Workspace access required/
    );
    await admin.query("UPDATE public.features SET name='Changed after snapshot' WHERE id=$1", [
      features[2],
    ]);
    await assert.rejects(
      api.plannerSaveProposal(account.id, workspace, { ...input, name: "Stale" }),
      /Roadmap changed/
    );
    assert.deepEqual(await api.plannerSavedProposal(account.id, workspace, id), preview);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    for (const operation of [
      () => api.plannerProposals(account.id, workspace),
      () => api.plannerSavedProposal(account.id, workspace, id),
      () => api.plannerPreview(account.id, workspace, input),
      () => api.plannerSaveProposal(account.id, workspace, { ...input, name: "Denied" }),
    ])
      await assert.rejects(operation(), /Workspace access required/);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("BEGIN");
    await admin.query("DELETE FROM platform.planner_priority_proposals WHERE workspace_id=$1", [
      workspace,
    ]);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.features WHERE project_id=$1", [project]);
    await admin.query("DELETE FROM public.projects WHERE workspace_id=$1", [workspace]);
    await admin.query("DELETE FROM public.workspaces WHERE id=$1", [workspace]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.query("COMMIT");
    await admin.end();
    await api.pool.end();
  }
});
