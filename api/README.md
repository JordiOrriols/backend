# Local platform API migration

This isolated branch adds a NestJS/TypeScript API and plain PostgreSQL 17.
It does not modify production workflows or publish packages.
Most internal editing workflows and three application adapters are not migrated yet.

The Shiplog and Planner isolated worktrees implement reduced views
at `/shiplog/workspaces/:workspace/releases` and
`/planner/workspaces/:workspace/roadmap`, with the Planner editing operations
described below. Other internal edits and the other three adapters are still
pending. Apply `sql/001-projections.sql` and
`sql/002-planner-source.sql`, `sql/003-planner-proposals.sql` and
`sql/004-planner-markers.sql`, `sql/005-planner-priorities.sql` and
`sql/006-planner-projects.sql`, `sql/007-planner-features.sql` and
`sql/008-planner-roadmap-settings.sql` to the isolated
database using its local Compose `exec db psql` command; never apply it to the
production database. Fresh imports apply these API SQL files automatically.
The API's workspace directory only lists explicit app/workspace grants.
Catalog responses reuse the existing reduced release projection, without
private engineering notes, audit entries or token settings.

The API Docker build uses the `planner` additional build context and a BuildKit
GitHub token secret to compile Planner's existing scheduler. The runtime image
contains only the bundled scheduler, without browser translations/auth hooks
or source duplication. Server scheduling uses its own English translation
instance and returns only the reduced roadmap projection.

Planner priority experiments now run entirely through the authenticated API:
`POST /api/planner/workspaces/:workspace/preview` accepts `featureIds` and
`expectedRevision`, recalculates the existing scheduler and never writes
official features. `POST .../proposals` adds a `name` and saves a separate
snapshot. `GET .../proposals` lists names/IDs/dates; `GET .../proposals/:id`
returns only the reduced roadmap. Every operation requires explicit Planner
workspace access, including external users; a Shiplog grant is insufficient.
The API reuses the existing database priority/dependency validation, preserves
the completed/in-progress prefix and rejects stale revisions.
Snapshots are shared only within that workspace's authorized Planner audience.
Technical scheduler inputs in snapshots remain unreadable to the API database
role and are never serialized to the browser. Previewing and saving never apply
priorities to the official plan. Legacy share-token
snapshots remain in the imported legacy table until a reviewed migration is
implemented; they are not automatically exposed through new workspace grants.

Marker management is also API-backed. Internal Planner owner/editor/viewer
grants can list `GET .../markers`; only owners/editors can create (`POST`),
rename (`PATCH .../markers/:id`) or delete (`DELETE .../markers/:id`).
Renaming changes only the name, preserving marker ID, workspace and date.
External users see the reduced name/date projection in the roadmap, never the
internal marker directory or edit controls. Writes are workspace-scoped,
validate names and calendar dates, and update the official roadmap revision.
Saved proposal snapshots remain unchanged when markers are edited.

Owners/editors can explicitly apply a reviewed experiment using
`POST /api/planner/workspaces/:workspace/priorities` with `featureIds` and
`expectedRevision`. The frontend requires a separate confirmation. To apply a
saved proposal, first try its priorities on the current plan: saved dates and
revisions are not copied into the official plan.
The write holds the matching grant and workspace locks, reuses the existing
preview/dependency checks, and updates only roadmap features' priorities.
Completed/in-progress work and its prefix stay locked. Backlog features,
estimates, names, statuses, vacations, markers and saved snapshots are unchanged.
Stale or invalid requests fail without partial writes; concurrent differing
orders from the same revision cannot both succeed. The response is the newly
scheduled reduced official roadmap, not raw scheduler inputs.
External/viewer users, wrong-app/workspace grants and revoked accounts cannot
perform this operation. The runtime role still cannot directly update features.
Vacation editing and capacity/planning configuration remain pending.

Project management reuses the existing Planner modal. Internal grants can list
`GET .../projects`; owners/editors can create (`POST`), rename
(`PATCH .../projects/:id`) and delete (`DELETE .../projects/:id`).
The directory returns only ID, workspace, name and an `in_use` flag. Names are
trimmed and validated to 1-80 characters. All writes are workspace-scoped and
hold the workspace lock. Deleting a project containing any feature, including
off-roadmap backlog tasks, returns 409 without deleting anything. The modal
disables that delete action. Wrong-workspace/missing IDs return 404; external
users cannot read this directory. Renaming preserves ID and feature membership.

Internal Planner grants can read `GET .../features`, including backlog,
descriptions and estimates; external grants cannot. Owners/editors can create
(`POST`), edit (`PATCH .../features/:id`) and delete (`DELETE .../features/:id`).
The existing estimation view, cards and feature modal are reused by both the
legacy page and the authenticated API page. Names, project IDs, statuses,
whole-number estimates and role pairs are validated before writes.
New tasks start outside the roadmap; editing cannot change inclusion, priority,
ID or creation time. Moving a task to another project in the same workspace is
allowed, but cross-workspace projects and task IDs are rejected.
Writes hold the grant and workspace locks and reuse the existing dependency
constraints. Self/unknown/cross-workspace dependencies, cycles, invalid roadmap
dependency ordering, and deleting a prerequisite are rejected atomically.
Only explicitly projected task fields are returned; the API role still cannot
read or write the legacy feature table directly. Task edits refresh the current
roadmap, while saved proposal snapshots are untouched.

Roadmap inclusion/removal uses `PATCH .../features/:id/inclusion` with an exact
boolean `included`. Only owners/editors can write. Inclusion appends to the
current roadmap under the workspace lock; repeat inclusion preserves priority.
Existing dependency validation rejects adding a dependant before its
prerequisite or removing a prerequisite while its dependant remains included.
Changing `PATCH .../start-date` with `date` also requires owner/editor access.
The API validates real dates and imports the verified-calendar predicate from
the existing Planner scheduler bundle instead of duplicating calendar years.
It returns the recalculated reduced roadmap; task fields and proposal snapshots
remain unchanged.

Root `npm test` runs the legacy migration tests only. The separate API package
uses Node's test runner via `npm --prefix api test`; CI installs and compiles
that package independently. CI does not import backups or run remote tests.

## Local Docker

Create an owner-readable, gitignored `.env` in this directory:

```dotenv
LOCAL_DB_PASSWORD=<random hex password>
LOCAL_API_DB_PASSWORD=<different random hex password>
LOCAL_BACKUP_DIR=<absolute directory containing roles.sql, schema.sql, data.sql and SHA256SUMS>
ACCESS_ISSUER=https://<team>.cloudflareaccess.com
ACCESS_AUDIENCE=<Access application audience>
```

```sh
docker compose --env-file .env -f compose.local.yml up -d db
docker compose --env-file .env -f compose.local.yml run --rm import
docker compose --env-file .env -f compose.local.yml run --rm integration
docker compose --env-file .env -f compose.local.yml up -d api
```

If the default Docker socket is unavailable, use `docker --context desktop-linux`.
No database port is published. The API is exposed only on `127.0.0.1:5300`.
The importer refuses a nonlocal database or an existing schema, verifies backup
checksums, restores application data transactionally and validates foreign keys.
It imports only legacy account IDs, emails, confirmation dates and metadata:
passwords, sessions, OAuth secrets and Supabase-managed storage are excluded.
Legacy `auth.users`/`auth.uid()` are temporary PostgreSQL compatibility objects
for existing functions, not an authentication service.
Storage object bytes, if used, need a separate migration.

The backup and imported volume contain personal data. Do not commit, upload or
use them in public previews. The Compose volume persists until explicitly removed.

## Identity and permissions

`GET /api/me` verifies `Cf-Access-Jwt-Assertion` using Cloudflare's rotating JWKS,
expected issuer, audience, RS256 signature, expiry and required user claims.
The API never accepts an email header as authentication.
Unknown issuer/subject pairs create a user with **no grants**.
Email is metadata and never automatically links an existing account.
Permission assignment uses the local administrator command described below.

Grants are scoped to app/workspace. `external` is allowed only for Planner and
Shiplog and will expose their reduced former shared-link projections, not private
records. Both reduced projection endpoints are implemented.
The API database role cannot read legacy app/account tables or assign permissions.
There are no password, registration, recovery or anonymous endpoints.
The production Docker image runs as a nonroot user and contains no dev tooling.

### Local administrator command

The user must first authenticate with Access (`GET /api/me`). Review the user's
platform UUID **and verified issuer/subject**, not just their email: identical
emails never imply identical accounts. This tool does not create identities,
link legacy accounts, or change application records.

Run the separate tools-profile container against the isolated database:

```sh
docker compose --env-file .env -f compose.local.yml build permissions
docker compose --env-file .env -f compose.local.yml run --rm permissions users
docker compose --env-file .env -f compose.local.yml run --rm permissions workspaces
docker compose --env-file .env -f compose.local.yml run --rm permissions grants
docker compose --env-file .env -f compose.local.yml run --rm permissions grant <platform-user-uuid> planner <workspace-uuid> external
docker compose --env-file .env -f compose.local.yml run --rm permissions revoke <platform-user-uuid> planner <workspace-uuid>
```

Export `GITHUB_TOKEN` for the build, as for the other images. Output from `users`
contains identity metadata and must remain private.
Apps: `planner`, `shiplog`, `ladders`, `pulse`, `agents`.
Roles: `owner`, `editor`, `viewer`, `external` (last only for Planner/Shiplog).
Granting an existing app/workspace replaces its role; revocation affects only
the specified account/app/workspace. Missing accounts, workspaces and grants
fail explicitly. Owner/editor grants unlock only the Planner editing operations
described above; other internal workflows remain unported.

Only this separate local tools container uses the administrator connection.
The HTTP API role still cannot assign or revoke grants, and no administrator
endpoint or public identity directory is added. The command requires
`LOCAL_PERMISSIONS_CONFIRM=local-only` and refuses any database target other
than `db:5432/platform`, including connection-string host overrides.
It is not a production administration tool.

## Validation

```sh
npm ci
npm run build
npm test
```

Integration tests run against the isolated Docker database only, create their own
identities and clean up only their own platform rows. Existing E2E configs still
use remote Supabase; do not run them as migration validation until a separate
local-only config and API-backed app adapters are in place.

The separate `platform-local.config.ts` in the isolated E2E worktree verifies
the new API and reduced app views. Start its local signed-token fixture with:

```sh
docker compose --env-file .env -f compose.local.yml -f compose.test.yml up -d api access-fixture
```

Then run `npx playwright test --config=platform-local.config.ts` from the
isolated E2E repository. This config has no production targets or remote auth
setup. The issuer/signing fixture is local-only, publishes only a loopback port,
and is not copied into the runtime Docker image. Real Cloudflare verification
uses the standard Compose configuration, not this test override.

To test the built frontend as well, export the registry `GITHUB_TOKEN` in your
shell and run:

```sh
docker compose --env-file .env -f compose.local.yml build permissions
docker compose --env-file .env -f compose.local.yml -f compose.test.yml --profile web up -d --build api planner shiplog gateway access-fixture
```

Run `PLATFORM_DOCKER_WEB=1 npx playwright test --config=platform-local.config.ts`
from the isolated E2E worktree. That test uses the loopback web container at
`http://127.0.0.1:5320/`, rejects nonlocal browser requests and checks
deep-route reloads, missing authentication and permission revocation.
Stop the `access-fixture` service after the checks and recreate `api` with only
`compose.local.yml` to restore real Access issuer/audience verification.

The gateway provides the single-origin layout for both apps. To start the
complete local test stack, explicitly include the test override in every
Compose command (omitting it resets the API to normal Access configuration):

```sh
docker compose --env-file .env -f compose.local.yml -f compose.test.yml --profile web up -d --build api planner shiplog gateway access-fixture
```

After recreating the API container, restart the local Nginx web/gateway services
so their upstream hostname resolutions point to the new container.
Do not use the local signed-token fixture in any external environment.
