# Local workerd pressure baseline

This fixture targets the real EdgeSonic Worker on Wrangler's local workerd runtime. It creates a local D1 database from `worker/migrations/Schema.sql`, then seeds 200 artists, 500 albums, 6,000 songs and 6,000 playable instances. It does not contact or copy production resources.

From the repository root, prepare the isolated local database:

```powershell
./test/pressure-baseline/prepare-local.ps1
```

In a separate terminal, start the Worker. The explicit `--local` flag disables remote bindings:

```powershell
npx wrangler dev --config test/pressure-baseline/wrangler.jsonc --local --persist-to test/pressure-baseline/.state --ip 127.0.0.1 --port 8787 --show-interactive-dev-session false
```

Use the repository's HTTP pressure tool for library stats and normal `search3`. Set each stage to at least 120 requests so concurrency 40 receives three waves. In a ramp, only the first stage is cold; later stages may be warm after the first refresh:

```powershell
$env:PRESSURE_BASE_URL = 'http://127.0.0.1:8787'
$env:PRESSURE_COOKIE = 'edgesonic_session=pressure-session-token'
$env:PRESSURE_REQUESTS = '120'
$env:PRESSURE_QUERY = 'LoadTest'
node scripts/http-pressure.mjs --scenario=stats --requests=120
node scripts/http-pressure.mjs --scenario=search3 --requests=120
```

The seeded stats row starts cold. After the first stats run, reset it to dirty and run a single-stage 40-concurrency burst. The shared pressure script supports `--concurrency=40` for this mode:

```powershell
npx wrangler d1 execute edgesonic-pressure-baseline-local --config test/pressure-baseline/wrangler.jsonc --local --persist-to test/pressure-baseline/.state --command "UPDATE library_stats_cache SET dirty = 1 WHERE id = 1;"
node scripts/http-pressure.mjs --scenario=stats --requests=120 --concurrency=40
```

The local fixture session is a fixed test token and only valid in the local D1 database. Do not use it with any deployed host. The measurements characterize local workerd + SQLite behavior; they are not production throughput estimates.
