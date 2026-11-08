# Local platform API migration

This isolated branch adds a NestJS/TypeScript API and plain PostgreSQL 17.
It does not modify production workflows or publish packages.
Internal editing workflows and three application adapters are not migrated yet.

The Shiplog and Planner isolated worktrees implement reduced read-only views
at `/shiplog/workspaces/:workspace/releases` and
`/planner/workspaces/:workspace/roadmap`. Internal edits and the other
three adapters are still pending. Apply `sql/001-projections.sql` and
`sql/002-planner-source.sql` to the isolated
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
fail explicitly. Changing a role does not yet unlock internal editing: those
workflows remain unported.

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
