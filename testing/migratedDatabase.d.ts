import type { PGlite } from "@electric-sql/pglite";

export type TestAccount = { id: string; email: string };

/** Folder holding the shared migrations shipped with this package. */
export declare const migrationsDirectory: URL;

/** Every migration file name, in the order Supabase applies them. */
export declare function migrationFiles(): Promise<string[]>;

/** Applies, in order, every migration from `from` (inclusive) up to `until` (exclusive). */
export declare function applyMigrations(
  db: PGlite,
  options?: { from?: string; until?: string }
): Promise<void>;

/**
 * PGlite with Supabase's auth stand-ins and the migrations applied in order. Pass `until`
 * to stop before a migration, seed data, and then finish with `applyMigrations`.
 */
export declare function createMigratedDatabase(
  accounts: TestAccount[],
  options?: { until?: string }
): Promise<PGlite>;
