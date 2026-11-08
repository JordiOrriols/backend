import { Pool } from "pg";
import type { AccessIdentity } from "./access.js";
import type { PriorityInput, ProposalInput, FeatureInput } from "./planner-input.js";

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

export interface PriorityProposal {
  id: string;
  name: string;
  created_at: string;
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

  async plannerPreview(
    accountId: string,
    workspaceId: string,
    input: PriorityInput
  ): Promise<unknown> {
    const result = await this.pool.query<{ source: unknown }>(
      "SELECT platform.planner_preview($1,$2,$3,$4) AS source",
      [accountId, workspaceId, input.featureIds, input.expectedRevision]
    );
    return result.rows[0]!.source;
  }

  async plannerApplyPriorities(
    accountId: string,
    workspaceId: string,
    input: PriorityInput
  ): Promise<unknown> {
    const result = await this.pool.query<{ source: unknown }>(
      "SELECT platform.planner_apply_priorities($1,$2,$3,$4) AS source",
      [accountId, workspaceId, input.featureIds, input.expectedRevision]
    );
    return result.rows[0]!.source;
  }

  async plannerProposals(accountId: string, workspaceId: string): Promise<PriorityProposal[]> {
    const result = await this.pool.query<{ id: string; name: string; created_at: Date }>(
      "SELECT id,name,created_at FROM platform.planner_proposals($1,$2)",
      [accountId, workspaceId]
    );
    return result.rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
  }

  async plannerSavedProposal(
    accountId: string,
    workspaceId: string,
    proposalId: string
  ): Promise<unknown> {
    const result = await this.pool.query<{ source: unknown }>(
      "SELECT platform.planner_saved_proposal($1,$2,$3) AS source",
      [accountId, workspaceId, proposalId]
    );
    return result.rows[0]!.source;
  }

  async plannerSaveProposal(
    accountId: string,
    workspaceId: string,
    input: ProposalInput
  ): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT platform.planner_save_proposal($1,$2,$3,$4,$5) AS id",
      [accountId, workspaceId, input.name, input.featureIds, input.expectedRevision]
    );
    return result.rows[0]!.id;
  }

  async plannerMarkers(accountId: string, workspaceId: string): Promise<unknown> {
    const result = await this.pool.query<{ markers: unknown }>(
      "SELECT platform.planner_markers($1,$2) AS markers",
      [accountId, workspaceId]
    );
    return result.rows[0]!.markers;
  }

  async plannerProjects(accountId: string, workspaceId: string): Promise<unknown> {
    const result = await this.pool.query<{ projects: unknown }>(
      "SELECT platform.planner_projects($1,$2) AS projects",
      [accountId, workspaceId]
    );
    return result.rows[0]!.projects;
  }

  async plannerFeatures(accountId: string, workspaceId: string): Promise<unknown> {
    const result = await this.pool.query<{ features: unknown }>(
      "SELECT platform.planner_features($1,$2) AS features",
      [accountId, workspaceId]
    );
    return result.rows[0]!.features;
  }

  async plannerToggleBacklog(
    accountId: string,
    workspaceId: string,
    featureId: string,
    included: boolean
  ): Promise<unknown> {
    const result = await this.pool.query<{ feature: unknown }>(
      "SELECT platform.planner_toggle_backlog($1,$2,$3,$4) AS feature",
      [accountId, workspaceId, featureId, included]
    );
    return result.rows[0]!.feature;
  }

  async plannerStartDate(accountId: string, workspaceId: string, date: string): Promise<unknown> {
    const result = await this.pool.query<{ source: unknown }>(
      "SELECT platform.planner_start_date($1,$2,$3) AS source",
      [accountId, workspaceId, date]
    );
    return result.rows[0]!.source;
  }

  async plannerFeature(
    accountId: string,
    workspaceId: string,
    action: "create" | "save" | "delete",
    featureId: string | null,
    input: FeatureInput | null
  ): Promise<unknown> {
    const result = await this.pool.query<{ feature: unknown }>(
      "SELECT platform.planner_feature($1,$2,$3,$4,$5) AS feature",
      [accountId, workspaceId, action, featureId, input]
    );
    return result.rows[0]!.feature;
  }

  async plannerProject(
    accountId: string,
    workspaceId: string,
    action: "create" | "rename" | "delete",
    projectId: string | null,
    name: string | null
  ): Promise<unknown> {
    const result = await this.pool.query<{ project: unknown }>(
      "SELECT platform.planner_project($1,$2,$3,$4,$5) AS project",
      [accountId, workspaceId, action, projectId, name]
    );
    return result.rows[0]!.project;
  }

  async plannerMarker(
    accountId: string,
    workspaceId: string,
    action: "create" | "rename" | "delete",
    markerId: string | null,
    name: string | null,
    date: string | null
  ): Promise<unknown> {
    const result = await this.pool.query<{ marker: unknown }>(
      "SELECT platform.planner_marker($1,$2,$3,$4,$5,$6) AS marker",
      [accountId, workspaceId, action, markerId, name, date]
    );
    return result.rows[0]!.marker;
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
