# Development

Local dev workflow, type-checking, running tests, and applying the database schema outside of a full deploy.

## Commands

Use the workspace Wrangler CLI (`pnpm exec wrangler`). Workspace dependencies include the pinned CLI.

```bash
pnpm install --frozen-lockfile              # install all workspaces

# Run worker dev server (Miniflare + local D1/R2)
pnpm run dev:worker

# Run frontend dev server (Vite HMR)
pnpm run dev:web

# Type-check all workspaces
pnpm run typecheck

# Run a single worker test (each file under test/ is self-contained, no
# aggregate runner — see the "Run:" comment at the top of each *.test.ts)
pnpm exec tsx test/subsonic/annotation.test.ts

# Run every test file
find test -name '*.test.ts' -exec pnpm exec tsx {} \;

```

## Apply the DB schema

`worker/migrations/Schema.sql` is the single source of truth — no incremental
patch files are kept or shipped. It is fully idempotent (`IF NOT EXISTS` /
`INSERT OR IGNORE`), so a fresh deployment executes it once and re-running it
on an existing database is safe. Schema changes are made by editing
Schema.sql and re-applying it:

```bash
./deploy.sh --migrate worker/migrations/Schema.sql
```

Or without a full deploy:

```bash
cd worker
wrangler d1 execute edgesonic-db --remote --file migrations/Schema.sql
```
