// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

const accounts = ["owner", "editor", "viewer", "otherApp", "linked", "outsider"].map(
  (name, index) => ({
    id: `${index + 1}1111111-1111-4111-8111-111111111111`,
    email: `${name.toLowerCase()}@example.com`,
  })
);
const owner = accounts[0]!;
let db: PGlite;
let workspace: string;
let otherWorkspace: string;
const tokens = new Map<string, string>();
async function login(account: string | null, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [account ?? ""]);
  await db.exec(`set role ${role}`);
}
async function value<T>(sql: string, args: unknown[] = []) {
  return (await db.query<{ value: T }>(sql, args)).rows[0]!.value;
}
beforeAll(async () => {
  db = await createMigratedDatabase(accounts);
  await login(owner.id);
  workspace = await value("select id as value from public.create_workspace('Sharing')");
  otherWorkspace = await value("select id as value from public.create_workspace('Other')");
  for (const app of ["planner", "shiplog"]) {
    for (const [index, access] of [
      [1, "editor"],
      [2, "viewer"],
    ] as const)
      await db.query("select public.share_workspace($1,$2,$3,$4)", [
        workspace,
        accounts[index]!.email,
        app,
        access,
      ]);
    const rpc = app === "planner" ? "planner_roadmap_share" : "shiplog_portal";
    tokens.set(app, await value(`select public.${rpc}($1,true) as value`, [workspace]));
  }
  await db.query("select public.share_workspace($1,$2,'pulse','editor')", [
    workspace,
    accounts[3]!.email,
  ]);
  const team = await value<string>("select (public.create_team('Linked',$1)).id as value", [
    workspace,
  ]);
  const member = await value<string>(
    "insert into public.members(team_id,name) values($1,'Linked member') returning id as value",
    [team]
  );
  const invite = await value<string>("select public.create_member_invite($1) as value", [member]);
  await login(accounts[4]!.id);
  await db.query("select public.claim_member_invite($1)", [invite]);
  await login(owner.id);
  // A linked account without an explicit app share must not gain the access directory.
  await db.query("select public.remove_workspace_share($1,$2,'planner')", [
    workspace,
    accounts[4]!.id,
  ]);
}, 30_000);
afterAll(async () => {
  await db?.close();
});

it("does not grant access through another app and removes read access immediately when a share is revoked", async () => {
  const account = accounts[3]!;
  await login(owner.id);
  await db.query("select public.share_workspace($1,$2,'planner','viewer')", [
    workspace,
    account.email,
  ]);
  await login(account.id);
  expect(await value("select public.planner_roadmap_share($1) as value", [workspace])).toBe(
    tokens.get("planner")
  );
  await expect(
    db.query("select * from public.list_workspace_app_shares($1,'shiplog')", [workspace])
  ).rejects.toThrow(/sharing access/);
  await expect(db.query("select public.shiplog_portal($1)", [workspace])).rejects.toThrow(
    /sharing access/
  );
  await login(owner.id);
  await db.query("select public.remove_workspace_share($1,$2,'planner')", [workspace, account.id]);
  await login(account.id);
  await expect(
    db.query("select * from public.list_workspace_app_shares($1,'planner')", [workspace])
  ).rejects.toThrow(/sharing access/);
  await expect(db.query("select public.planner_roadmap_share($1)", [workspace])).rejects.toThrow(
    /sharing access/
  );
});

it.each(["planner", "shiplog"])(
  "%s scopes directories and token reads while keeping link writes owner-only",
  async (app) => {
    const rpc = app === "planner" ? "planner_roadmap_share" : "shiplog_portal";
    for (const account of accounts.slice(0, 3)) {
      await login(account.id);
      const rows = (
        await db.query<{ app: string; email: string }>(
          "select * from public.list_workspace_app_shares($1,$2)",
          [workspace, app]
        )
      ).rows;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.app === app)).toBe(true);
      expect(rows.map((row) => row.email)).toEqual(["editor@example.com", "viewer@example.com"]);
      expect(await value(`select public.${rpc}($1) as value`, [workspace])).toBe(tokens.get(app));
      if (account.id === owner.id) continue;
      await expect(
        db.query("select * from public.list_workspace_shares($1)", [workspace])
      ).rejects.toThrow(/owner access/);
      for (const enabled of [true, false])
        await expect(db.query(`select public.${rpc}($1,$2)`, [workspace, enabled])).rejects.toThrow(
          /owner access/
        );
      await expect(
        db.query("select public.share_workspace($1,'outsider@example.com',$2,'viewer')", [
          workspace,
          app,
        ])
      ).rejects.toThrow(/owner access/);
      await expect(
        db.query("select * from public.list_workspace_app_shares($1,$2)", [otherWorkspace, app])
      ).rejects.toThrow(/sharing access/);
      await expect(db.query(`select public.${rpc}($1)`, [otherWorkspace])).rejects.toThrow(
        /sharing access/
      );
    }
    for (const account of accounts.slice(3)) {
      await login(account.id);
      await expect(
        db.query("select * from public.list_workspace_app_shares($1,$2)", [workspace, app])
      ).rejects.toThrow(/sharing access/);
      await expect(db.query(`select public.${rpc}($1)`, [workspace])).rejects.toThrow(
        /sharing access/
      );
    }
    await login(null, "anon");
    await expect(
      db.query("select * from public.list_workspace_app_shares($1,$2)", [workspace, app])
    ).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.${rpc}($1)`, [workspace])).rejects.toThrow(
      /permission denied/
    );
    await login(owner.id);
    await expect(
      db.query("select * from public.list_workspace_app_shares($1,'invalid')", [workspace])
    ).rejects.toThrow(/Invalid app/);
    expect(await value(`select public.${rpc}($1,false) as value`, [workspace])).toBeNull();
    await login(accounts[2]!.id);
    expect(await value(`select public.${rpc}($1) as value`, [workspace])).toBeNull();
    await login(owner.id);
    const next = await value<string>(`select public.${rpc}($1,true) as value`, [workspace]);
    expect(next).not.toBe(tokens.get(app));
  }
);
