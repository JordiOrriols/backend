# Local platform API migration

This isolated branch adds a NestJS/TypeScript API and plain PostgreSQL 17.
It does not modify production workflows or publish packages.
Most application adapters and internal editing workflows are not migrated yet.

The Shiplog isolated worktree now implements its read-only catalog via browser
paths at `/shiplog/workspaces/:workspace/releases`. Internal edits and the other
four adapters are still pending. Apply `sql/001-projections.sql` to the isolated
database using its local Compose `exec db psql` command; never apply it to the
production database. Fresh imports apply these API SQL files automatically.
The API's workspace directory only lists explicit app/workspace grants.
Catalog responses reuse the existing reduced release projection, without
private engineering notes, audit entries or token settings.

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
Permission assignment is manual during this migration.

Grants are scoped to app/workspace. `external` is allowed only for Planner and
Shiplog and will expose their reduced former shared-link projections, not private
records. Those projection endpoints are not implemented yet.
The API database role cannot read legacy app/account tables or assign permissions.
There are no password, registration, recovery or anonymous endpoints.
The production Docker image runs as a nonroot user and contains no dev tooling.

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
the new API only. Start its local signed-token fixture with:

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
docker compose --env-file .env -f compose.local.yml -f compose.test.yml up -d --build shiplog
```

Run `PLATFORM_DOCKER_WEB=1 npx playwright test --config=platform-local.config.ts`
from the isolated E2E worktree. That test uses the loopback web container at
`http://127.0.0.1:5310/shiplog/`, rejects nonlocal browser requests and checks
deep-route reloads, missing authentication and permission revocation.
Stop the `access-fixture` service after the checks and recreate `api` with only
`compose.local.yml` to restore real Access issuer/audience verification.
