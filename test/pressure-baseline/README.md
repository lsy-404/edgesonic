# Local workerd pressure baseline

This fixture runs the built frontend and real EdgeSonic Worker on local workerd. It seeds 200 artists, 500 albums, 6,000 songs, synthetic visitor sessions and a local R2 bucket containing a small cover and five seconds of silent WAV audio. It does not copy production resources. External artist lookups are disabled in the fixture.

From the repository root, prepare the isolated local database:

```powershell
$env:EDGESONIC_VERSION = 'dev'
npm run build:web
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

## Browsing with concurrent writes

Run the same browsing journeys first without writes, then with concurrent favorite toggles and test-owned playlist edits:

```powershell
node test/pressure-baseline/visit-pressure.mjs --base-url=http://127.0.0.1:8787 --mode=compare --visitors=8 --concurrency=8 --visits=16
```

The simulator accepts only loopback HTTP origins and fixed fixture identities. It follows page dependencies while overlapping independent requests, including authentication/profile checks, messages, Home lists, library tabs and pagination, search, artist/album detail, favorites, playlists, cover images, lyrics and audio ranges. Writes use disposable playlists with a two-song replacement and synthetic songs. It reports endpoint latency, protocol errors and observed read/write overlap. Visitor concurrency is distinct from simultaneous HTTP requests because one page can issue several requests. HTML/JavaScript/CSS startup loads are covered by the separate browser capture, not this API workload.

The default comparison performs one warm-up and three measured pairs; use `--warmups=0 --rounds=1` for a smoke run. Browser caching, cold artist/lyrics lookups, remote SSO, third-party services, real audio sizes, transcoding and Cloudflare network conditions are not reproduced by this fixture. A shared local database cannot establish production capacity or prove zero write/read interference. Quota isolation is verified separately by `test/internal/rate_limit_middleware.test.ts`.

```powershell
node --test test/visit-pressure.test.mjs
```
