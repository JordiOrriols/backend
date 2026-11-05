# Working rules

## Commit in small pieces, as you go

Every commit is one milestone you could describe in a sentence, and it leaves
the repo in a state worth having. Never commit a failing test.

## Checks

```sh
npm run format:check && npm run typecheck && npm test
npm run db:start && npm run db:test   # needs Docker
```

## The shared database

Every app (Agents, Ladders, Planner, Pulse and Shiplog) uses this one Supabase
project. This repository is the only place for migrations, database tests,
Auth email templates and the Supabase configuration; apps must not add their
own `supabase/migrations`.

- Never edit or rename a migration that has been applied; add a new one after
  the latest.
- Name migrations `<timestamp>_<app>_<change>.sql`.
- Database-only tests go in `tests/<app>/` (PGlite, through
  `testing/migratedDatabase.js`) or `supabase/tests` (pgTAP). Tests that check
  the database against app code stay in that app.
- Apply migrations to the hosted project only with the user's explicit
  approval: `npm run db:backup`, then `npm run db:push:dry`, then
  `npm run db:push`. Never reset the hosted database or push Auth settings.

## Secrets

Never write credentials, tokens, database passwords or backups into a commit,
a file in the repo or a summary.
