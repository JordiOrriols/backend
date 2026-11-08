# Local platform API migration

This isolated branch adds a NestJS/TypeScript API and plain PostgreSQL 17.
It does not modify production workflows or publish packages.
Ladders evaluations/member management, the Pulse/Agents adapters, shared workspace
lifecycle and explicit legacy account mapping are not migrated yet.

The Shiplog and Planner isolated worktrees implement reduced views
at `/shiplog/workspaces/:workspace/releases` and
`/planner/workspaces/:workspace/roadmap`, with the Planner editing operations
described below. Shiplog primary workflows are API-backed, and Ladders now has a
team/member directory with team creation/renaming. Apply `sql/001-projections.sql` and
`sql/002-planner-source.sql`, `sql/003-planner-proposals.sql` and
`sql/004-planner-markers.sql`, `sql/005-planner-priorities.sql` and
`sql/006-planner-projects.sql`, `sql/007-planner-features.sql` and
`sql/008-planner-roadmap-settings.sql`, `sql/009-planner-calendar.sql`,
`sql/010-planner-teams.sql`, `sql/011-shiplog-applications.sql` and
`sql/012-shiplog-releases.sql`, `sql/013-shiplog-checklists.sql` and
`sql/014-shiplog-decisions.sql`, `sql/015-shiplog-audit.sql` and
`sql/016-ladders-teams.sql` to the isolated
database using its local Compose `exec db psql` command; never apply it to the
production database. Fresh imports apply these API SQL files automatically.
The API's workspace directory only lists explicit app/workspace grants.
Catalog responses reuse the existing reduced release projection, without
private engineering notes, audit entries or token settings.

Ladders internal grants read `GET /api/ladders/workspaces/:workspace/teams`.
The response contains team IDs/names and member IDs/team IDs/names/roles/planning
roles, never legacy owner/account IDs, personal tokens, evaluations or comments.
Only owners create with `POST .../teams`; owners/editors rename with
`PATCH .../teams/:team`. Shared name validation enforces 1-120 trimmed characters.
Writes lock the explicit Ladders grant and workspace and reject foreign team IDs.
Legacy workspace-owner FKs remain storage metadata, not verified identity links.
Planner grants do not confer Ladders access; same-email subjects remain distinct.
The isolated Ladders worktree serves authenticated hash-free `/ladders/` routes
through the local gateway on port 5320 (direct app port 5314). It reuses UI layout,
language/footer and team-name dialogs without initializing old browser Supabase
or password/anonymous flows. Evaluations, member writes, goals, deletion and
shared lifecycle remain pending; the draft is not a production replacement.

Internal Shiplog grants can read `GET .../applications`, returning explicit
application fields, an `in_use` flag and workspace team IDs/names. External
grants retain only the reduced catalog. Owners/editors can create (`POST`),
edit (`PATCH .../applications/:id`) and delete (`DELETE .../applications/:id`).
Names/descriptions/team IDs are validated; cross-workspace teams or application
IDs are rejected. Any release prevents application deletion. Writes lock the
grant, workspace and existing application; updates preserve identity/timestamps.
Audit events are stored separately under `platform.shiplog_audit_events`,
with the verified platform account as actor. They never impersonate or link
legacy accounts. The runtime cannot read/write that audit table directly.
The existing application form/cards are reused.

Shiplog owners/editors create releases with `POST .../releases` and save
configuration with `PATCH .../releases/:id`. The existing release form is shared
with the legacy adapter. Version/type detection reuses the existing PostgreSQL
SemVer implementation, excluding the edited release; application versions remain
unique. Drafts allow version/title/feature editing; notes and manual status remain
editable in every status, matching the existing independent QA/approval behavior.
`feature_ids: null` preserves links, while an array replaces them atomically with
the release fields and status. Link changes and `GET .../features` require an
additional internal Planner grant in the same workspace. Cross-workspace features
are rejected and existing linked names remain snapshots. Internal Shiplog users
read linked IDs/names through `GET .../releases/:id/features`; external users retain
only name-only catalog content. Writes lock grants/workspace/application/release
and audit the verified platform actor. New releases leave the legacy `created_by`
FK unset, rather than impersonating an old account, and retain the existing
checklist snapshot trigger.

Internal Shiplog grants read application checklist templates and release
readiness through `GET .../applications/:id/checklist-template` and
`GET .../releases/:id/readiness`. Only owners save templates with `PATCH`,
providing the current revision and at most 100 validated item definitions.
Stale revisions return 409; reload before saving. The existing release creation
trigger snapshots templates, so edits affect only future releases.
Owners/editors complete or clear checks through
`PATCH .../releases/:id/checklist/:item` with `{ completed: boolean }`.
Release/item/workspace boundaries are enforced under locks. QA completion does
not change manual release status. Verified platform completion actors are stored
separately in `platform.shiplog_checklist_completions`, never written into legacy
actor FKs. Reads preserve imported completion unless explicitly changed; repeated
completion preserves the original completion actor/time. All writes audit the
platform actor. Viewers inspect QA without writing; external grants cannot read
templates/readiness. Existing template, QA modal and checklist views are shared
with legacy adapters.

Internal Shiplog users read `GET .../releases/:id/decisions` and record their own
decision through `PATCH .../releases/:id/decision` with `{ approved: boolean }`.
Viewers can decide, matching the existing independent-member approval behavior,
but still cannot edit releases/templates/checks. Decisions are independent of
manual status and QA. Caller identity is always taken from the verified Access
account, never from request fields. Grant/workspace/release locks serialize writes.
The response includes the caller account ID and only active internal grant
participants, with IDs, email-local-part display names, decisions and dates;
full emails and legacy member metadata are not projected. Same-email subjects
retain distinct platform IDs. Revoked/external participants disappear from the
directory, while their stored decisions/audit remain.
Platform decisions live separately in `platform.shiplog_release_decisions`.
Imported legacy approvals remain untouched and are not attributed to Access
users without explicit account mapping; mapped member display names also remain
pending that separate step. Existing thumbs controls and QA placement are reused.
Internal Shiplog grants read `GET .../audit`, which merges platform and imported
legacy events in newest-first order. Each event explicitly identifies its source;
legacy actor UUIDs are never presented as verified platform accounts. Platform
display names omit full email addresses. Event details retain stored snapshots,
including application deletion history. External users cannot read the history.
Responses contain at most 50 events and `next_cursor: string | null`; pass the
returned `cursor` query parameter for the next page. Cursors are workspace-scoped
source/UUID pairs, ordered by timestamp/source/ID to avoid gaps on timestamp ties.
Missing/deleted/foreign cursor events return 404, malformed cursors return 400.
The runtime cannot mutate either audit ledger directly. The localized read-only
history page is linked from internal workspace, application and release navigation.
Shiplog primary workflows are now API-backed; shared lifecycle, explicit legacy
identity mapping and real corporate Access acceptance still remain.

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

Internal grants can read `GET .../calendar`: workspace teams, a minimal member
roster, vacations and sprint settings. It excludes vacation/share tokens,
account emails and evaluation records; external grants cannot read it.
Owners/editors can save ranges using
`POST .../members/:member/vacations` with `{start,end,working}`. Dates must be
real, in the verified calendar and span at most 366 days inclusive.
The member must belong to a team in that workspace. `working: true` removes
nonworking vacation rows, restoring normal weekends/holidays without creating
working overrides. There is no implicit self-edit or legacy member linking
by email: edit permission comes from the workspace owner/editor grant.

`PATCH .../calibration` accepts `{anchor,history}` for owners/editors.
Structural validation precedes the actual Planner sprint validator exported
in the scheduler bundle, preserving its calendar, alignment, uniqueness and
nonnegative-point rules. Writes lock the grant/workspace and preserve proposal
snapshots. The authenticated vacation route reuses the existing calendar,
timeline, capacity forecast and calibration modal.
Planner owners can create teams using `POST .../teams` with `{name}` (trimmed,
1–120 characters). Editors cannot add teams, preserving the existing owner-only
behavior. Owners/editors can change or clear a member's planning role through
`PATCH .../members/:member/planning-role` with `{role}`: backend, frontend,
design, qa or explicit null. The member must belong to this workspace.
Only the planning role changes, not job titles, identity links or share tokens.
Writes lock the grant/workspace, refresh capacity/roadmap inputs and preserve
proposal snapshots. The existing team configuration view is shared with the
legacy adapter; the API version has no copy-vacation-link action.
During compatibility migration, new teams retain the workspace's legacy
storage-owner foreign key. This is not an identity link or a legacy permission
grant for the Access caller. Authorization uses platform grants only.
Reviewed member identity mapping remains pending; no anonymous member vacation
links are active in this branch.

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
