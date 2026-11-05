// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

const owner = "11111111-1111-4111-8111-111111111111";
const person = "22222222-2222-4222-8222-222222222222";
const stranger = "33333333-3333-4333-8333-333333333333";
const unverified = "44444444-4444-4444-8444-444444444444";
let db: PGlite;
let workspace: string;
let team: string;
let ada: { id: string; view_token: string };
let grace: string;

async function login(id: string | null, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? ""]);
  await db.exec(`set role ${role}`);
}
async function value<T>(sql: string, params: unknown[] = []) {
  return (await db.query<{ value: T }>(sql, params)).rows[0]?.value;
}
async function invite(member = ada.id) {
  await login(owner);
  return (await value<string>("select public.create_member_invite($1) as value", [member]))!;
}
async function claim(token: string, account = person) {
  await login(account);
  return (
    await db.query<{ member_id: string; workspace_id: string }>(
      "select * from public.claim_member_invite($1)",
      [token]
    )
  ).rows[0]!;
}

beforeAll(async () => {
  db = await createMigratedDatabase([
    { id: owner, email: "owner@example.com" },
    { id: person, email: "Ada@Example.com" },
    { id: stranger, email: "stranger@example.com" },
    { id: unverified, email: "new@example.com" },
  ]);
  await db.query("update auth.users set email_confirmed_at = null where id = $1", [unverified]);
});
beforeEach(async () => {
  await login(null, "postgres");
  await db.exec(
    "delete from public.members; delete from public.teams where workspace_id in (select id from public.workspaces where not created_for_team); delete from public.workspaces where not created_for_team"
  );
  await login(owner);
  workspace = (await value<string>("select id as value from public.create_workspace('Squad')"))!;
  team = (await value<string>("select (public.create_team('Core', $1)).id as value", [workspace]))!;
  ada = (
    await db.query<typeof ada>(
      "insert into public.members(team_id,name) values($1,'Ada') returning id,view_token",
      [team]
    )
  ).rows[0]!;
  grace = (await value<string>(
    "insert into public.members(team_id,name) values($1,'Grace') returning id as value",
    [team]
  ))!;
});
afterAll(async () => {
  await db?.close();
});

describe("Members linked to accounts", () => {
  it("links an account through a one-time invite and shares Planner and Pulse as a viewer", async () => {
    const token = await invite();
    await login(person);
    expect((await db.query("select * from public.member_invite($1)", [token])).rows).toEqual([
      { member_name: "Ada", workspace_id: workspace, workspace_name: "Squad" },
    ]);
    expect(await claim(token)).toEqual({ member_id: ada.id, workspace_id: workspace });

    await login(null, "postgres");
    expect(await value("select user_id as value from public.members where id=$1", [ada.id])).toBe(
      person
    );
    expect(
      (
        await db.query(
          "select app, access_level, email from public.workspace_collaborators where user_id=$1 order by app",
          [person]
        )
      ).rows
    ).toEqual([
      { app: "planner", access_level: "viewer", email: "ada@example.com" },
      { app: "pulse", access_level: "viewer", email: "ada@example.com" },
    ]);
    await expect(claim(token, stranger)).rejects.toThrow("no longer valid");
  });

  it("keeps an existing share level when the person claims", async () => {
    await login(owner);
    await db.query("select public.share_workspace($1,'ada@example.com','planner','editor')", [
      workspace,
    ]);
    await claim(await invite());
    await login(person);
    expect(await value("select public.workspace_access($1,'planner') as value", [workspace])).toBe(
      "editor"
    );
    expect(await value("select public.workspace_access($1,'pulse') as value", [workspace])).toBe(
      "viewer"
    );
  });

  it("lists the workspace in Ladders as 'member' and opens only the linked member's view page", async () => {
    await claim(await invite());
    await login(person);
    expect(await value("select public.workspace_access($1,'ladders') as value", [workspace])).toBe(
      "member"
    );
    expect((await db.query("select id, name from public.my_member($1)", [workspace])).rows).toEqual(
      [{ id: ada.id, name: "Ada" }]
    );
    expect(
      (await db.query("select * from public.resolve_token($1)", [ada.view_token])).rows
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.view_sharing_links($1)", [ada.view_token])).rows
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.token_goals_list($1)", [ada.view_token])).rows
    ).toEqual([]);
    // The team itself stays private.
    expect((await db.query("select id from public.members")).rows).toEqual([]);

    await login(stranger);
    expect(
      (await db.query("select * from public.resolve_token($1)", [ada.view_token])).rows
    ).toEqual([]);
    await expect(
      db.query("select * from public.view_sharing_links($1)", [ada.view_token])
    ).rejects.toThrow();
  });

  it("lets the linked person edit only their own vacations", async () => {
    await claim(await invite());
    await login(person);
    const roster = await db.query<{
      name: string;
      can_edit: boolean;
      vacation_token: string | null;
    }>("select name, can_edit, vacation_token from public.planner_workspace_roster($1)", [
      workspace,
    ]);
    expect(roster.rows).toEqual([
      { name: "Ada", can_edit: true, vacation_token: null },
      { name: "Grace", can_edit: false, vacation_token: null },
    ]);
    await db.query("select public.planner_set_vacations($1,'2026-11-02','2026-11-03',false)", [
      ada.id,
    ]);
    await db.query("delete from public.vacations where member_id=$1 and date='2026-11-03'", [
      ada.id,
    ]);
    expect(
      (await db.query("select date from public.vacations where member_id=$1", [ada.id])).rows
    ).toHaveLength(1);
    await expect(
      db.query("select public.planner_set_vacations($1,'2026-11-02','2026-11-02',false)", [grace])
    ).rejects.toThrow("Team edit access required");
    await expect(
      db.query("insert into public.vacations values($1,'2026-11-02',false)", [grace])
    ).rejects.toThrow();
  });

  it("only links through an invite and lets editors unlink", async () => {
    await login(owner);
    await expect(
      db.query("update public.members set user_id=$2 where id=$1", [ada.id, person])
    ).rejects.toThrow("only through an invite");
    expect(
      await value(
        "insert into public.members(team_id,name,user_id) values($1,'Eve',$2) returning user_id as value",
        [team, owner]
      )
    ).toBeNull();

    const token = await invite();
    expect(
      (await db.query("select * from public.member_links($1) where member_id=$2", [team, ada.id]))
        .rows
    ).toEqual([{ member_id: ada.id, linked: false, invited: true }]);
    await claim(token);
    await expect(invite()).rejects.toThrow("already linked");
    await expect(claim(await invite(grace))).rejects.toThrow("already linked to another member");

    await login(person);
    await expect(db.query("select public.unlink_member($1)", [ada.id])).rejects.toThrow(
      "Team edit access"
    );
    await login(owner);
    await db.query("select public.unlink_member($1)", [ada.id]);
    expect(
      await value("select user_id as value from public.members where id=$1", [ada.id])
    ).toBeNull();
  });

  it("refuses outsiders, unverified accounts and expired invites", async () => {
    await login(stranger);
    await expect(db.query("select public.create_member_invite($1)", [ada.id])).rejects.toThrow();
    await expect(db.query("select * from public.member_links($1)", [team])).rejects.toThrow();
    await expect(db.query("select * from public.member_invites")).rejects.toThrow();

    const token = await invite();
    await expect(claim(token, unverified)).rejects.toThrow("verified email");
    await login(null, "postgres");
    await db.query("update public.member_invites set created_at = now() - interval '31 days'");
    await expect(claim(token)).rejects.toThrow("no longer valid");
    await login(null, "anon");
    await expect(db.query("select * from public.member_invite($1)", [token])).rejects.toThrow();
  });

  it("does not share the workspace with its own owner", async () => {
    await claim(await invite(), owner);
    await login(null, "postgres");
    expect(await value("select count(*)::int as value from public.workspace_collaborators")).toBe(
      0
    );
    expect(await value("select user_id as value from public.members where id=$1", [ada.id])).toBe(
      owner
    );
  });
});
