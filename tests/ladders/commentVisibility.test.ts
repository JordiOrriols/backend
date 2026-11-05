// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrationsDirectory } from "../../testing/migratedDatabase.js";

const owner = "11111111-1111-4111-8111-111111111111";
const viewer = "22222222-2222-4222-8222-222222222222";
const stranger = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
let member: {
  id: string;
  team_id: string;
  view_token: string;
  self_token: string;
  peer_token: string;
};
let peer: string;
let manager: string;
async function login(id: string | null, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  await db.exec(`set role ${role}`);
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    grant usage on schema auth, public to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    insert into auth.users values ('${owner}','owner@example.com'),('${viewer}','viewer@example.com'),('${stranger}','stranger@example.com');
  `);
  for (const file of [
    "0001_init.sql",
    "0002_editable_drafts.sql",
    "0003_teams_and_sharing.sql",
    "20261010190000_comment_visibility.sql",
  ]) {
    const sql = await readFile(new URL(file, migrationsDirectory), "utf8");
    await db.exec(sql.replace("create extension if not exists pgcrypto;", ""));
  }
});
beforeEach(async () => {
  await login(null, "postgres");
  await db.exec("delete from public.members; delete from public.team_collaborators");
  await login(owner);
  member = (
    await db.query<typeof member>(
      "insert into public.members(name,view_enabled) values('Ada',true) returning id,team_id,view_token,self_token,peer_token"
    )
  ).rows[0]!;
  peer = (
    await db.query<{ id: string }>(
      'insert into public.evaluations(member_id,kind,status,comments) values($1,\'peer\',\'published\',\'{"Technology":"Private peer feedback","People":"Second peer comment"}\') returning id',
      [member.id]
    )
  ).rows[0]!.id;
  manager = (
    await db.query<{ id: string }>(
      "insert into public.evaluations(member_id,kind,status,comments) values($1,'manager','published','{\"Technology\":\"Manager feedback\"}') returning id",
      [member.id]
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await db?.close();
});

describe("Server-enforced per-comment visibility", () => {
  it("defaults peer comments to hidden without losing ratings or manager comments", async () => {
    await login(null, "anon");
    const rows = (
      await db.query<{ id: string; comments: Record<string, string>; comment_visibility: object }>(
        "select * from public.public_view($1)",
        [member.view_token]
      )
    ).rows;
    expect(rows.find((row) => row.id === peer)?.comments).toEqual({});
    expect(rows.find((row) => row.id === manager)?.comments).toEqual({
      Technology: "Manager feedback",
    });
    expect(rows.every((row) => Object.keys(row.comment_visibility).length === 0)).toBe(true);
  });
  it("shares and hides each peer comment independently, including already published versions", async () => {
    await db.query("select public.set_evaluation_comment_visibility($1,'Technology',true)", [peer]);
    await login(null, "anon");
    expect(
      (
        await db.query<{ comments: object }>(
          "select comments from public.public_view($1) where id=$2",
          [member.view_token, peer]
        )
      ).rows[0]?.comments
    ).toEqual({ Technology: "Private peer feedback" });
    await login(owner);
    await db.query("select public.set_evaluation_comment_visibility($1,'Technology',false)", [
      peer,
    ]);
    await db.query("select public.set_evaluation_comment_visibility($1,'Technology',false)", [
      manager,
    ]);
    await login(null, "anon");
    expect(
      (
        await db.query<{ comments: object }>("select comments from public.public_view($1)", [
          member.view_token,
        ])
      ).rows.every((row) => Object.keys(row.comments).length === 0)
    ).toBe(true);
    await login(owner);
    expect(
      (
        await db.query<{ comments: object }>(
          "select comments from public.evaluations where id=$1",
          [peer]
        )
      ).rows[0]?.comments
    ).toEqual({ Technology: "Private peer feedback", People: "Second peer comment" });
  });
  it("allows hiding self comments in the employee view without taking away the employee's own answers", async () => {
    await login(null, "anon");
    const self = (
      await db.query<{ id: string }>(
        "select id from public.self_save($1,'draft','{}','{}','{\"Technology\":\"Own answer\"}')",
        [member.self_token]
      )
    ).rows[0]!.id;
    await login(owner);
    await db.query("select public.set_evaluation_comment_visibility($1,'Technology',false)", [
      self,
    ]);
    await login(null, "anon");
    expect(
      (
        await db.query<{ comments: object }>(
          "select comments from public.public_view($1) where id=$2",
          [member.view_token, self]
        )
      ).rows[0]?.comments
    ).toEqual({});
    expect(
      (
        await db.query<{ comments: object }>("select comments from public.self_list($1)", [
          member.self_token,
        ])
      ).rows[0]?.comments
    ).toEqual({ Technology: "Own answer" });
  });
  it("denies viewer, outsider and anonymous changes and refuses malformed categories", async () => {
    await db.query("select public.share_team_by_email($1,'viewer@example.com','viewer')", [
      member.team_id,
    ]);
    for (const id of [viewer, stranger]) {
      await login(id);
      await expect(
        db.query("select public.set_evaluation_comment_visibility($1,'Technology',true)", [peer])
      ).rejects.toThrow(/edit access/);
    }
    await login(null, "anon");
    await expect(
      db.query("select public.set_evaluation_comment_visibility($1,'Technology',true)", [peer])
    ).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.evaluations")).rejects.toThrow(/permission denied/);
    await login(owner);
    for (const category of ["Unknown", "System", null]) {
      await expect(
        db.query("select public.set_evaluation_comment_visibility($1,$2,true)", [peer, category])
      ).rejects.toThrow(/existing competency comment/);
    }
  });
  it("preserves version publication rules and refuses wrong or disabled view tokens", async () => {
    await db.query("update public.evaluations set status='draft' where id=$1", [peer]);
    await db.query("select public.set_evaluation_comment_visibility($1,'Technology',true)", [peer]);
    await login(null, "anon");
    expect(
      (
        await db.query("select id from public.public_view($1) where id=$2", [
          member.view_token,
          peer,
        ])
      ).rows
    ).toHaveLength(0);
    for (const token of [member.self_token, member.peer_token, crypto.randomUUID()]) {
      expect((await db.query("select * from public.public_view($1)", [token])).rows).toHaveLength(
        0
      );
    }
    await login(owner);
    await db.query("update public.members set view_enabled=false where id=$1", [member.id]);
    await login(null, "anon");
    expect(
      (await db.query("select * from public.public_view($1)", [member.view_token])).rows
    ).toHaveLength(0);
  });
});
