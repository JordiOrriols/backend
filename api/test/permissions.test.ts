import assert from "node:assert/strict";
import { test } from "node:test";
import { localPermissionConnection, parsePermissionCommand } from "../scripts/local-permissions.js";

const user = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";

test("local permission commands validate exact IDs, apps, roles and argument counts", () => {
  for (const action of ["users", "workspaces", "grants"])
    assert.deepEqual(parsePermissionCommand([action]), { action });
  assert.deepEqual(parsePermissionCommand(["grant", user, "planner", workspace, "external"]), {
    action: "grant",
    userId: user,
    app: "planner",
    workspaceId: workspace,
    role: "external",
  });
  assert.deepEqual(parsePermissionCommand(["revoke", user, "shiplog", workspace]), {
    action: "revoke",
    userId: user,
    app: "shiplog",
    workspaceId: workspace,
  });
  for (const app of ["planner", "shiplog", "ladders", "pulse", "agents"])
    for (const role of ["owner", "editor", "viewer"])
      assert.deepEqual(parsePermissionCommand(["grant", user, app, workspace, role]), {
        action: "grant",
        userId: user,
        app,
        workspaceId: workspace,
        role,
      });
  for (const args of [
    [],
    ["users", "extra"],
    ["delete"],
    ["grant", user, "planner", workspace],
    ["revoke", user, "planner", workspace, "owner"],
    ["grant", "bad-id", "planner", workspace, "owner"],
    ["grant", user, "planner", "bad-id", "owner"],
    ["grant", user, "unknown", workspace, "owner"],
    ["grant", user, "planner", workspace, "admin"],
    ...["ladders", "pulse", "agents"].map((app) => ["grant", user, app, workspace, "external"]),
  ])
    assert.throws(() => parsePermissionCommand(args));
});

test("permission administration refuses remote, ambiguous or unconfirmed database targets", () => {
  const env = {
    LOCAL_PERMISSIONS_CONFIRM: "local-only",
    DATABASE_URL: "postgres://postgres:local@db:5432/platform",
  };
  assert.equal(localPermissionConnection(env), env.DATABASE_URL);
  assert.throws(() => localPermissionConnection({ DATABASE_URL: env.DATABASE_URL }));
  for (const url of [
    "postgres://postgres:local@production/platform",
    "postgres://postgres:local@localhost/platform",
    "postgres://postgres:local@db/other",
    "postgres://postgres:local@db:5433/platform",
    "postgres://postgres:local@db/platform?host=production",
    "postgres://postgres:local@db/platform#ignored",
    "https://db/platform",
  ])
    assert.throws(() => localPermissionConnection({ ...env, DATABASE_URL: url }));
});
