// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

const owner = "11111111-1111-4111-8111-111111111111";
const viewer = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
let workspace: string;
let release: string;
async function login(account: string | null, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [account ?? ""]);
  await db.exec(`set role ${role}`);
}
async function value<T>(sql: string, args: unknown[] = []) {
  return (await db.query<{ value: T }>(sql, args)).rows[0]!.value;
}
async function linkedMember(targetWorkspace: string, name: string, account = owner) {
  const team = await value<string>("select (public.create_team($1,$2)).id as value", [
    name,
    targetWorkspace,
  ]);
  const member = await value<string>(
    "insert into public.members(team_id,name) values($1,$2) returning id as value",
    [team, name]
  );
  const invite = await value<string>("select public.create_member_invite($1) as value", [member]);
  await login(account);
  await db.query("select public.claim_member_invite($1)", [invite]);
  await login(owner);
  return team;
}
beforeAll(async () => {
  db = await createMigratedDatabase([
    { id: owner, email: "owner@example.com" },
    { id: viewer, email: "viewer@example.com" },
    { id: outsider, email: "outsider@example.com" },
  ]);
  await login(owner, "postgres");
  await db.query("update auth.users set raw_user_meta_data=$1::jsonb where id=$2", [
    JSON.stringify({
      full_name: "Account Owner",
      private_metadata: "SECRET",
    }),
    owner,
  ]);
  await db.query("update auth.users set raw_user_meta_data=$1::jsonb where id=$2", [
    JSON.stringify({ name: "Account Viewer" }),
    viewer,
  ]);
  await login(owner);
  workspace = await value("select id as value from public.create_workspace('Approvals')");
  await db.query("select public.share_workspace($1,'viewer@example.com','shiplog','viewer')", [
    workspace,
  ]);
  const otherWorkspace = await value<string>(
    "select id as value from public.create_workspace('Other workspace')"
  );
  await linkedMember(otherWorkspace, "SECRET other member");
  await linkedMember(otherWorkspace, "SECRET viewer name", viewer);
  await linkedMember(workspace, "General member");
  const team = await linkedMember(workspace, "Application member");
  const app = await value<string>(
    "select (public.shiplog_save_application($1,'Website','',$2)).id as value",
    [workspace, team]
  );
  release = await value("select (public.shiplog_create_release($1::jsonb)).id as value", [
    JSON.stringify({
      application_id: app,
      version: "1.0.0",
      title: "Launch",
      public_notes: "Story",
    }),
  ]);
  await db.query("select public.shiplog_decide_release($1,true)", [release]);
}, 30_000);
afterAll(async () => {
  await db?.close();
});

it("returns the application-team member name first with allowlisted account data and preserves votes", async () => {
  await login(viewer);
  const rows = (
    await db.query("select * from public.shiplog_list_release_decisions($1)", [release])
  ).rows;
  expect(rows).toEqual([
    expect.objectContaining({
      user_id: owner,
      name: "Application member",
      member_name: "Application member",
      account_name: "Account Owner",
      email: "owner@example.com",
      approved: true,
    }),
    expect.objectContaining({
      user_id: viewer,
      name: "viewer@example.com",
      member_name: null,
      account_name: "Account Viewer",
      email: "viewer@example.com",
      approved: null,
    }),
  ]);
  expect(JSON.stringify(rows)).not.toContain("SECRET");
  expect(Object.keys(rows[0]!).sort()).toEqual([
    "account_name",
    "approved",
    "decided_at",
    "email",
    "member_name",
    "name",
    "user_id",
  ]);
});
it("does not grant name-directory access to outsiders or anonymous users", async () => {
  await login(outsider);
  await expect(
    db.query("select * from public.shiplog_list_release_decisions($1)", [release])
  ).rejects.toThrow("Shiplog access");
  await login(null, "anon");
  await expect(
    db.query("select * from public.shiplog_list_release_decisions($1)", [release])
  ).rejects.toThrow("permission denied");
});
