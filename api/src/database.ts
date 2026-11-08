import { Pool } from "pg";
import type { AccessIdentity } from "./access.js";

export const APPLICATIONS = ["planner", "shiplog", "ladders", "pulse", "agents"] as const;
export type Application = (typeof APPLICATIONS)[number];

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}

export interface PlatformAccount {
  id: string;
  email: string;
  grants: { app: string; workspaceId: string; role: string }[];
}

export class PlatformDatabase {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async workspaces(accountId: string, app: Application): Promise<WorkspaceSummary[]> {
    const result = await this.pool.query<WorkspaceSummary>(
      "SELECT * FROM platform.workspace_directory($1,$2)",
      [accountId, app]
    );
    return result.rows;
  }

  async shiplogCatalog(accountId: string, workspaceId: string): Promise<unknown> {
    const result = await this.pool.query<{ catalog: unknown }>(
      "SELECT platform.shiplog_catalog($1,$2) AS catalog",
      [accountId, workspaceId]
    );
    return result.rows[0]!.catalog;
  }

  async plannerSource(accountId: string, workspaceId: string): Promise<unknown> {
    const result = await this.pool.query<{ source: unknown }>(
      "SELECT platform.planner_source($1,$2) AS source",
      [accountId, workspaceId]
    );
    return result.rows[0]!.source;
  }

  async account(identity: AccessIdentity): Promise<PlatformAccount> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([identity.issuer, identity.subject]),
      ]);
      let { rows } = await client.query<{ id: string }>(
        "SELECT user_id AS id FROM platform.identities WHERE issuer=$1 AND subject=$2",
        [identity.issuer, identity.subject]
      );
      let id = rows[0]?.id;
      if (!id) {
        const created = await client.query<{ id: string }>(
          "INSERT INTO platform.users(email) VALUES($1) RETURNING id",
          [identity.email]
        );
        id = created.rows[0]!.id;
        await client.query(
          "INSERT INTO platform.identities(issuer,subject,user_id) VALUES($1,$2,$3)",
          [identity.issuer, identity.subject, id]
        );
      } else {
        await client.query("UPDATE platform.users SET email=$2 WHERE id=$1", [id, identity.email]);
      }
      const grants = await client.query<PlatformAccount["grants"][number]>(
        'SELECT app, workspace_id AS "workspaceId", role FROM platform.grants WHERE user_id=$1 ORDER BY app,workspace_id',
        [id]
      );
      await client.query("COMMIT");
      return { id, email: identity.email, grants: grants.rows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
