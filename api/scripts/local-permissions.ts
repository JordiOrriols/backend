import type { Client } from "pg";
import { APPLICATIONS, type Application } from "../src/database.js";

const ROLES = ["owner", "editor", "viewer", "external"] as const;
type Role = (typeof ROLES)[number];
type PermissionCommand =
  | { action: "users" | "workspaces" | "grants" | "legacy-users" | "mappings" }
  | { action: "grant"; userId: string; app: Application; workspaceId: string; role: Role }
  | { action: "revoke"; userId: string; app: Application; workspaceId: string }
  | { action: "map-legacy" | "unmap-legacy"; userId: string; legacyUserId: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function localPermissionConnection(env: NodeJS.ProcessEnv): string {
  const connection = env.DATABASE_URL;
  if (!connection || env.LOCAL_PERMISSIONS_CONFIRM !== "local-only")
    throw new Error("Permission administration requires LOCAL_PERMISSIONS_CONFIRM=local-only");
  const url = new URL(connection);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "db" ||
    url.pathname !== "/platform" ||
    (url.port && url.port !== "5432") ||
    url.search ||
    url.hash
  )
    throw new Error("Permission administration is restricted to the isolated Docker db/platform");
  return connection;
}

export function parsePermissionCommand(args: string[]): PermissionCommand {
  const [action, userId, app, workspaceId, role] = args;
  if (
    (action === "users" ||
      action === "workspaces" ||
      action === "grants" ||
      action === "legacy-users" ||
      action === "mappings") &&
    args.length === 1
  )
    return { action };
  if (action === "map-legacy" || action === "unmap-legacy") {
    if (args.length !== 3 || !userId || !app || !uuid.test(userId) || !uuid.test(app))
      throw new Error(`Usage: ${action} <verified-platform-user-id> <legacy-user-id>`);
    return { action, userId, legacyUserId: app };
  }
  if ((action !== "grant" && action !== "revoke") || args.length !== (action === "grant" ? 5 : 4))
    throw new Error(
      "Usage: users | workspaces | grants | legacy-users | mappings | map-legacy <user-id> <legacy-user-id> | unmap-legacy <user-id> <legacy-user-id> | grant <user-id> <app> <workspace-id> <role> | revoke <user-id> <app> <workspace-id>"
    );
  if (!userId || !workspaceId || !uuid.test(userId) || !uuid.test(workspaceId))
    throw new Error("User and workspace must be UUIDs");
  const application = APPLICATIONS.find((candidate) => candidate === app);
  if (!application) throw new Error("Unknown application");
  if (action === "revoke") return { action, userId, app: application, workspaceId };
  const permission = ROLES.find((candidate) => candidate === role);
  if (!permission) throw new Error("Unknown role");
  if (permission === "external" && application !== "planner" && application !== "shiplog")
    throw new Error("External access is supported only for Planner and Shiplog");
  return { action, userId, app: application, workspaceId, role: permission };
}

export async function runPermissionCommand(client: Client, args: string[]): Promise<unknown> {
  const command = parsePermissionCommand(args);
  if (command.action === "users")
    return (
      await client.query(
        `SELECT u.id,u.email,i.issuer,i.subject FROM platform.users u
         JOIN platform.identities i ON i.user_id=u.id ORDER BY u.id,i.issuer,i.subject`
      )
    ).rows;
  if (command.action === "workspaces")
    return (await client.query("SELECT id,name FROM public.workspaces ORDER BY id")).rows;
  if (command.action === "grants")
    return (
      await client.query(
        `SELECT user_id,app,workspace_id,role FROM platform.grants
         ORDER BY user_id,app,workspace_id`
      )
    ).rows;
  if (command.action === "legacy-users")
    return (await client.query("SELECT id,email FROM auth.users ORDER BY id")).rows;
  if (command.action === "mappings")
    return (
      await client.query(
        "SELECT user_id,legacy_user_id,created_at FROM platform.legacy_account_mappings ORDER BY user_id"
      )
    ).rows;
  if (
    command.action !== "grant" &&
    command.action !== "revoke" &&
    command.action !== "map-legacy" &&
    command.action !== "unmap-legacy"
  )
    throw new Error("Unsupported permission command");

  await client.query("BEGIN");
  try {
    const account = await client.query(
      `SELECT id FROM platform.users WHERE id=$1
       AND EXISTS (SELECT 1 FROM platform.identities WHERE user_id=$1) FOR KEY SHARE`,
      [command.userId]
    );
    if (!account.rowCount)
      throw new Error("Unknown platform user: the user must first authenticate through Access");
    if (command.action === "map-legacy" || command.action === "unmap-legacy") {
      const legacy = await client.query("SELECT id FROM auth.users WHERE id=$1 FOR KEY SHARE", [
        command.legacyUserId,
      ]);
      if (!legacy.rowCount) throw new Error("Unknown legacy user");
      const values = [command.userId, command.legacyUserId];
      let result =
        command.action === "map-legacy"
          ? await client.query(
              `INSERT INTO platform.legacy_account_mappings(user_id,legacy_user_id) VALUES($1,$2)
               ON CONFLICT DO NOTHING RETURNING user_id,legacy_user_id,created_at`,
              values
            )
          : await client.query(
              `DELETE FROM platform.legacy_account_mappings WHERE user_id=$1 AND legacy_user_id=$2
               RETURNING user_id,legacy_user_id,created_at`,
              values
            );
      if (!result.rowCount && command.action === "map-legacy") {
        result = await client.query(
          `SELECT user_id,legacy_user_id,created_at FROM platform.legacy_account_mappings
           WHERE user_id=$1 AND legacy_user_id=$2 FOR SHARE`,
          values
        );
        if (!result.rowCount)
          throw new Error("Account already mapped: explicitly unmap the existing pair first");
      }
      if (!result.rowCount) throw new Error("No matching legacy mapping to remove");
      await client.query("COMMIT");
      return { action: command.action, mapping: result.rows[0] };
    }
    const workspace = await client.query(
      "SELECT id FROM public.workspaces WHERE id=$1 FOR KEY SHARE",
      [command.workspaceId]
    );
    if (!workspace.rowCount) throw new Error("Unknown workspace");
    const values = [command.userId, command.app, command.workspaceId];
    const result =
      command.action === "grant"
        ? await client.query(
            `INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,$2,$3,$4)
             ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=EXCLUDED.role
             RETURNING user_id,app,workspace_id,role`,
            [...values, command.role]
          )
        : await client.query(
            `DELETE FROM platform.grants WHERE user_id=$1 AND app=$2 AND workspace_id=$3
             RETURNING user_id,app,workspace_id,role`,
            values
          );
    if (!result.rowCount) throw new Error("No matching grant to revoke");
    await client.query("COMMIT");
    return { action: command.action, grant: result.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
