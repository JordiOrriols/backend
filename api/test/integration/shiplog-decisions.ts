import test from "node:test";
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
  throw new Error("Isolated Docker database required");
test("Shiplog decisions belong only to verified internal identities and never change legacy decisions or release status", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const account = await api.account({
    issuer: "https://shiplog-decisions.invalid",
    subject: randomUUID(),
    email: "ada@example.invalid",
  });
  const second = await api.account({
    issuer: "https://shiplog-decisions.invalid",
    subject: randomUUID(),
    email: "ada@example.invalid",
  });
  const outside = await api.account({
    issuer: "https://shiplog-decisions.invalid",
    subject: randomUUID(),
    email: "private@example.invalid",
  });
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    app = randomUUID(),
    release = randomUUID(),
    otherApp = randomUUID(),
    foreign = randomUUID();
  const accounts = [account.id, second.id, outside.id];
  const grant = (id: string, scope: string, role: string) =>
    admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'shiplog',$2,$3) ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role",
      [id, scope, role]
    );
  try {
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Decision test'),($2,$3,'Other decision test')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.shiplog_applications(id,workspace_id,name) VALUES($1,$3,'App'),($2,$4,'Other app')",
      [app, otherApp, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.shiplog_releases(id,workspace_id,application_id,version,release_type,title,status) VALUES($1,$3,$5,'1.0.0','major','Released','released'),($2,$4,$6,'1.0.0','major','Foreign','draft')",
      [release, foreign, workspace, other, app, otherApp]
    );
    await admin.query(
      "INSERT INTO public.shiplog_release_decisions(release_id,user_id,approved) VALUES($1,$2,true)",
      [release, owner]
    );
    const legacy = (
      await admin.query("SELECT * FROM public.shiplog_release_decisions WHERE release_id=$1", [
        release,
      ])
    ).rows;
    await assert.rejects(api.shiplogDecisions(account.id, workspace, release), /Internal Shiplog/);
    await assert.rejects(
      api.shiplogDecideRelease(account.id, workspace, release, true),
      /Internal Shiplog/
    );
    await grant(account.id, workspace, "external");
    await assert.rejects(api.shiplogDecisions(account.id, workspace, release), /Internal Shiplog/);
    await assert.rejects(
      api.shiplogDecideRelease(account.id, workspace, release, false),
      /Internal Shiplog/
    );
    await grant(account.id, workspace, "viewer");
    await grant(second.id, workspace, "editor");
    await grant(outside.id, workspace, "external");
    await grant(outside.id, other, "owner");
    const initial = await api.shiplogDecisions(account.id, workspace, release);
    assert.ok(
      initial &&
        typeof initial === "object" &&
        "decisions" in initial &&
        Array.isArray(initial.decisions)
    );
    assert.equal(initial.decisions.length, 2);
    assert.ok(
      initial.decisions.every(
        (row) => row.name === "ada" && row.approved === null && !("email" in row)
      )
    );
    await api.shiplogDecideRelease(account.id, workspace, release, true);
    await api.shiplogDecideRelease(second.id, workspace, release, false);
    const first = (
      await admin.query(
        "SELECT * FROM platform.shiplog_release_decisions WHERE release_id=$1 AND user_id=$2",
        [release, account.id]
      )
    ).rows[0];
    await api.shiplogDecideRelease(second.id, workspace, release, true);
    assert.deepEqual(
      (
        await admin.query(
          "SELECT * FROM platform.shiplog_release_decisions WHERE release_id=$1 AND user_id=$2",
          [release, account.id]
        )
      ).rows[0],
      first
    );
    await api.shiplogDecideRelease(account.id, workspace, release, false);
    assert.equal(
      (
        await admin.query(
          "SELECT approved FROM platform.shiplog_release_decisions WHERE release_id=$1 AND user_id=$2",
          [release, account.id]
        )
      ).rows[0].approved,
      false
    );
    await grant(account.id, other, "owner");
    await assert.rejects(
      api.shiplogDecideRelease(account.id, other, release, true),
      /Release unavailable/
    );
    await assert.rejects(
      api.shiplogDecisions(account.id, workspace, foreign),
      /Release unavailable/
    );
    await assert.rejects(
      api.pool.query("SELECT platform.shiplog_decide_release($1,$2,$3,NULL)", [
        account.id,
        workspace,
        release,
      ]),
      /Approval decision/
    );
    await assert.rejects(
      api.pool.query("SELECT * FROM platform.shiplog_release_decisions"),
      /permission denied/
    );
    assert.deepEqual(
      (
        await admin.query("SELECT * FROM public.shiplog_release_decisions WHERE release_id=$1", [
          release,
        ])
      ).rows,
      legacy
    );
    assert.equal(
      (await admin.query("SELECT status FROM public.shiplog_releases WHERE id=$1", [release]))
        .rows[0].status,
      "released"
    );
    await grant(second.id, workspace, "external");
    const reduced = await api.shiplogDecisions(account.id, workspace, release);
    assert.ok(
      reduced &&
        typeof reduced === "object" &&
        "decisions" in reduced &&
        Array.isArray(reduced.decisions)
    );
    assert.equal(reduced.decisions.length, 1);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM platform.shiplog_release_decisions WHERE release_id=$1",
          [release]
        )
      ).rows[0].n,
      2
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.shiplogDecideRelease(account.id, workspace, release, true),
      /Internal Shiplog/
    );
    const audit = (
      await admin.query(
        "SELECT actor_id,details FROM platform.shiplog_audit_events WHERE workspace_id=$1",
        [workspace]
      )
    ).rows;
    assert.equal(audit.length, 4);
    assert.ok(
      audit.every((row) => row.details.release_id === release && accounts.includes(row.actor_id))
    );
  } finally {
    await admin.query("DELETE FROM platform.grants WHERE user_id=ANY($1::uuid[])", [accounts]);
    await admin.query("DELETE FROM public.shiplog_releases WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query(
      "DELETE FROM public.shiplog_applications WHERE workspace_id=ANY($1::uuid[])",
      [[workspace, other]]
    );
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [accounts]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [accounts]);
    await admin.end();
    await api.pool.end();
  }
});
