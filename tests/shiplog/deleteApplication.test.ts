// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

const owner = "11111111-1111-4111-8111-111111111111";
const editor = "22222222-2222-4222-8222-222222222222";
const viewer = "33333333-3333-4333-8333-333333333333";
const outsider = "44444444-4444-4444-8444-444444444444";
let db: PGlite;
let workspace: string;
async function login(account: string | null, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [account ?? ""]);
  await db.exec(`set role ${role}`);
}
async function createApp() {
  await login(owner);
  return (
    await db.query<{ id: string }>(
      "select (public.shiplog_save_application($1,'Delete test')).id",
      [workspace]
    )
  ).rows[0]!.id;
}
beforeAll(async () => {
  db = await createMigratedDatabase(
    [owner, editor, viewer, outsider].map((id, i) => ({
      id,
      email: `member${i}@example.com`,
    }))
  );
  await login(owner);
  workspace = (
    await db.query<{ id: string }>("select id from public.create_workspace('Application deletion')")
  ).rows[0]!.id;
  for (const [email, app, access] of [
    ["member1@example.com", "shiplog", "editor"],
    ["member2@example.com", "shiplog", "viewer"],
    ["member3@example.com", "planner", "editor"],
  ])
    await db.query("select public.share_workspace($1,$2,$3,$4)", [workspace, email, app, access]);
});
afterAll(async () => {
  await db?.close();
});

describe("deleting applications without losing release history", () => {
  it.each([owner, editor])(
    "permits authorized deletion by %s and records the deleted application",
    async (account) => {
      const app = await createApp();
      await db.query("select public.shiplog_save_checklist_template($1,$2::jsonb,0)", [
        app,
        JSON.stringify([
          {
            title: "Check",
            category: "QA",
            description: "",
            mandatory: true,
          },
        ]),
      ]);
      await login(account);
      await db.query("select public.shiplog_delete_application($1)", [app]);
      expect(
        (await db.query("select id from public.shiplog_applications where id=$1", [app])).rows
      ).toHaveLength(0);
      const audit = await db.query<{
        application_id: string | null;
        actor_id: string;
      }>(
        "select application_id, actor_id from public.shiplog_audit_events where event='application.deleted' and details->'before'->>'id'=$1",
        [app]
      );
      expect(audit.rows).toEqual([{ application_id: null, actor_id: account }]);
      expect(
        (
          await db.query(
            "select application_id from public.shiplog_checklist_templates where application_id=$1",
            [app]
          )
        ).rows
      ).toHaveLength(0);
    }
  );
  it("rejects deletion with releases and preserves both records", async () => {
    const app = await createApp();
    await db.query("select public.shiplog_create_release($1::jsonb)", [
      JSON.stringify({
        application_id: app,
        version: "1.0.0",
        title: "Keep me",
        public_notes: "",
      }),
    ]);
    await expect(db.query("select public.shiplog_delete_application($1)", [app])).rejects.toThrow(
      "Applications with releases cannot be deleted"
    );
    expect(
      (await db.query("select id from public.shiplog_applications where id=$1", [app])).rows
    ).toHaveLength(1);
    expect(
      (await db.query("select id from public.shiplog_releases where application_id=$1", [app])).rows
    ).toHaveLength(1);
  });
  it.each([viewer, outsider, null])("denies deletion for %s", async (account) => {
    const app = await createApp();
    await login(account, account ? "authenticated" : "anon");
    await expect(db.query("select public.shiplog_delete_application($1)", [app])).rejects.toThrow();
    await login(owner);
    expect(
      (await db.query("select id from public.shiplog_applications where id=$1", [app])).rows
    ).toHaveLength(1);
  });
  it("reports a missing application explicitly", async () => {
    await login(owner);
    await expect(
      db.query("select public.shiplog_delete_application('55555555-5555-4555-8555-555555555555')")
    ).rejects.toThrow("Application not found");
  });
});
