# Work Mode metadata retrieval browser fixture

This loopback-only page runs the actual `runTask`, Vite module worker, `searchAll`, NetEase search/detail/lyric adapter, same-origin `/tag/scrape` transport, and the server's Hono dispatch/submit handlers. It seeds a fresh in-memory SQLite database from `worker/migrations/Schema.sql`, queues a fixture song, and reads the catalog back after server-side apply.

The D1 binding and coordinator claim are local test shims, and R2 writes are disabled. No real provider or music files are used. Before server changes are integrated into the repository, set `WORKMODE_SERVER_SOURCE_ROOT` to the server worktree path to run this fixture against that source.

Run from the repository root:

```powershell
pnpm exec vite --config test/workmode-metadata-retrieval-browser/vite.config.mts
```

For a not-yet-integrated server worktree, set `$env:WORKMODE_SERVER_SOURCE_ROOT` to its repository root before starting Vite.

Open `http://127.0.0.1:4181/` and click **Run metadata retrieval fixture**. The report shows provider intents, the server apply receipt, queue state, and the SQLite catalog readback.
