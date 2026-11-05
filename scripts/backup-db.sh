#!/usr/bin/env bash
# Full, restorable backup of the linked Supabase database that every app shares.
# Follows Supabase's documented roles/schema/data split.
#
# Requirements: Docker running and the Supabase CLI logged in and linked.
# Usage: npm run db:backup            (writes to ./backups/<UTC timestamp>/)
#        BACKUP_DIR=/path npm run db:backup
#
# Backups contain personal data (auth users, evaluations). The folder is
# gitignored and files are created owner-readable only.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1 && [ -z "${DOCKER_HOST:-}" ]; then
  # The active context may point at /var/run/docker.sock while Docker Desktop
  # listens on its own socket; use it without changing the user's context.
  desktop_host="$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  if [ -n "$desktop_host" ]; then
    export DOCKER_HOST="$desktop_host"
  fi
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${BACKUP_DIR:-backups}/${stamp}"
umask 077
mkdir -p "$target"

supabase() { npx supabase "$@"; }

echo "Backing up linked project $(cat supabase/.temp/project-ref) into ${target}"
supabase db dump --linked --role-only -f "${target}/roles.sql"
supabase db dump --linked -f "${target}/schema.sql"
supabase db dump --linked --data-only --use-copy -f "${target}/data.sql"
supabase migration list --linked >"${target}/migrations.txt"

for file in roles.sql schema.sql data.sql; do
  if [ ! -s "${target}/${file}" ]; then
    echo "Backup failed: ${file} is empty" >&2
    exit 1
  fi
done

(cd "$target" && shasum -a 256 roles.sql schema.sql data.sql migrations.txt >SHA256SUMS)

echo "Tables with data:"
grep -E '^COPY ' "${target}/data.sql" | sed -E 's/^COPY ([^ ]+).*/  \1/' | sort -u
echo "Done: ${target}"
echo "Restore: psql \"\$DB_URL\" -f roles.sql -f schema.sql -c 'SET session_replication_role = replica' -f data.sql"
