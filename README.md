# Backend

The shared Supabase backend behind every JordiOrriols app: Agents, Ladders,
Planner, Pulse and Shiplog all use one Supabase project and one schema. This
repository is the only place that schema lives.

| Folder                 | What it holds                                                             |
| ---------------------- | ------------------------------------------------------------------------- |
| `supabase/migrations`  | The full migration history, in the order Supabase applies it              |
| `supabase/tests`       | pgTAP tests, run against the real Supabase Postgres image                 |
| `supabase/templates`   | The shared Auth emails (see [their README](supabase/templates/README.md)) |
| `supabase/config.toml` | Local stack and Auth configuration                                        |
| `tests`                | Database tests per app, run on PGlite (no Docker needed)                  |
| `testing`              | The PGlite helper published for the apps' own contract tests              |
| `scripts/backup-db.sh` | Full, restorable backup of the hosted database                            |

The Planner `roadmap` Edge Function stays in the Planner repository: it reuses
Planner's scheduling code, so moving it here would mean copying that code.

## Set up

Node.js 26 (`nvm use`). The Supabase CLI is a dev dependency, so every command
below uses the pinned version.

```sh
npm ci
npx supabase link --project-ref <project-ref>
```

## Checks

```sh
npm run format:check && npm run typecheck
npm test          # every migration on PGlite, plus the email templates
npm run db:start  # the real Supabase Postgres in Docker, every migration from scratch
npm run db:test   # pgTAP tests against it
npm run db:stop
```

CI runs all of them on every pull request.

## Add a migration

1. `npm run db:new -- <app>_<change>` creates `supabase/migrations/<timestamp>_<app>_<change>.sql`.
   Prefix the name with the app it belongs to; shared changes use `workspace_` or `shared_`.
2. Test it in `tests/<app>/` with `createMigratedDatabase` (or in `supabase/tests` with pgTAP
   when it needs the real Postgres image).
3. Open a pull request. Merging it publishes a new `@jordiorriols/backend` version, so apps can
   run their contract tests against the new schema.
4. Apply it to the hosted project (below), **before** deploying any app that needs it.

## Apply migrations to the hosted project

Nothing is applied automatically. Back up first, review the dry run, then push:

```sh
npm run db:backup     # needs Docker; writes to ./backups (gitignored, personal data)
npm run db:push:dry   # must list only the migrations you intend to apply
npm run db:push
```

Do not reset the shared database, and do not push the local Auth configuration to production.
The email templates are installed by hand; see [supabase/templates](supabase/templates/README.md).

## Use the package in an app

Apps install `@jordiorriols/backend` as a dev dependency from GitHub Packages, the same way as
`@jordiorriols/ui`, and test their own code against the real schema:

```ts
import { createMigratedDatabase } from "@jordiorriols/backend/testing";

const db = await createMigratedDatabase([{ id: owner, email: "owner@example.com" }]);
```

`createMigratedDatabase` creates a PGlite database with stand-ins for Supabase's `auth` schema
and roles, and applies every migration in order. Pass `{ until: "<migration>" }` to stop early,
seed data, and finish with `applyMigrations(db, { from: "<migration>" })`. `migrationFiles()` and
`migrationsDirectory` expose the raw files. `@electric-sql/pglite` is a peer dependency.

Keep tests here when they only exercise the database; keep them in the app when they check the
database against app code (Zod contracts, the scheduler, and so on).

## Publishing

Every push to `main` publishes the next patch version to GitHub Packages once the checks pass,
then commits the bump and a `vX.Y.Z` tag back to `main`.
