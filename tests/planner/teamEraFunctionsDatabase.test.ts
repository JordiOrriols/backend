// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDatabase([
    { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" },
  ]);
});
afterAll(async () => {
  await db.close();
});

describe("team era functions", () => {
  it("are gone, while the workspace versions stay", async () => {
    const functions = await db.query<{ signature: string }>(
      `select p.oid::regprocedure::text as signature from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1) order by 1`,
      [
        [
          "create_team",
          "list_team_shares",
          "share_team_by_email",
          "update_team_share",
          "remove_team_share",
          "planner_create_linked_workspace",
          "share_workspace",
        ],
      ]
    );
    expect(functions.rows.map((row) => row.signature)).toEqual([
      "create_team(text,uuid)",
      "share_workspace(uuid,text,text,text)",
    ]);
  });
});
