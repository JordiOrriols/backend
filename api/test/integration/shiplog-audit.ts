import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { auditCursorInput } from "../../src/shiplog-input.js";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Isolated Docker database required");
test("Shiplog audit merges distinct legacy/platform history with exact keyset pagination and internal scope", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const account = await api.account({
    issuer: "https://shiplog-audit.invalid",
    subject: randomUUID(),
    email: "audit@example.invalid",
  });
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    foreign = randomUUID();
  const grant = (role: string) =>
    admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'shiplog',$2,$3) ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role",
      [account.id, workspace, role]
    );
  try {
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Audit test'),($2,$3,'Other audit test')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO platform.shiplog_audit_events(id,workspace_id,actor_id,event,details) VALUES($1,$2,$3,'Foreign event','{}')",
      [foreign, other, account.id]
    );
    await assert.rejects(api.shiplogAudit(account.id, workspace, null), /Internal Shiplog/);
    await grant("external");
    await assert.rejects(api.shiplogAudit(account.id, workspace, null), /Internal Shiplog/);
    await grant("viewer");
    assert.deepEqual(await api.shiplogAudit(account.id, workspace, null), {
      events: [],
      next_cursor: null,
    });
    await admin.query(
      `INSERT INTO platform.shiplog_audit_events(workspace_id,actor_id,event,details,created_at)
      SELECT $1,$2,'platform.' || n,jsonb_build_object('n',n),'2026-11-08T12:00:00Z'::timestamptz FROM generate_series(1,60) n`,
      [workspace, account.id]
    );
    await admin.query(
      `INSERT INTO public.shiplog_audit_events(workspace_id,actor_id,event,details,created_at)
      SELECT $1,$2,'legacy.' || n,jsonb_build_object('n',n),'2026-11-08T12:00:00Z'::timestamptz FROM generate_series(1,60) n`,
      [workspace, owner]
    );
    const expected = (
      await admin.query(
        `SELECT source || ':' || id AS key FROM (
      SELECT id,'platform'::text AS source,created_at FROM platform.shiplog_audit_events WHERE workspace_id=$1
      UNION ALL SELECT id,'legacy'::text,created_at FROM public.shiplog_audit_events WHERE workspace_id=$1
      ) h ORDER BY created_at DESC,source COLLATE "C" DESC,id DESC`,
        [workspace]
      )
    ).rows.map((row) => row.key);
    const keys: string[] = [];
    let cursor: string | undefined;
    for (const size of [50, 50, 20]) {
      const page = await api.shiplogAudit(account.id, workspace, auditCursorInput(cursor));
      assert.ok(
        page &&
          typeof page === "object" &&
          "events" in page &&
          Array.isArray(page.events) &&
          "next_cursor" in page
      );
      assert.equal(page.events.length, size);
      for (const event of page.events) {
        keys.push(`${event.source}:${event.id}`);
        assert.ok(!("workspace_id" in event) && !("email" in event));
        assert.equal(event.actor_id, event.source === "platform" ? account.id : owner);
        assert.equal(event.actor_name, event.source === "platform" ? "audit" : null);
      }
      if (size === 20) assert.equal(page.next_cursor, null);
      else {
        assert.equal(typeof page.next_cursor, "string");
        assert.ok(typeof page.next_cursor === "string");
        cursor = page.next_cursor;
      }
    }
    assert.deepEqual(keys, expected);
    assert.equal(new Set(keys).size, 120);
    await assert.rejects(
      api.shiplogAudit(account.id, workspace, { source: "platform", id: foreign }),
      /cursor unavailable/
    );
    await assert.rejects(
      api.shiplogAudit(account.id, workspace, { source: "legacy", id: randomUUID() }),
      /cursor unavailable/
    );
    await assert.rejects(api.shiplogAudit(account.id, other, null), /Internal Shiplog/);
    await assert.rejects(
      api.pool.query("SELECT * FROM platform.shiplog_audit_events"),
      /permission denied/
    );
    await assert.rejects(
      api.pool.query("DELETE FROM platform.shiplog_audit_events"),
      /permission denied/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(api.shiplogAudit(account.id, workspace, null), /Internal Shiplog/);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM public.shiplog_audit_events WHERE workspace_id=$1",
          [workspace]
        )
      ).rows[0].n,
      60
    );
  } finally {
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query(
      "DELETE FROM public.shiplog_audit_events WHERE workspace_id=ANY($1::uuid[])",
      [[workspace, other]]
    );
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
