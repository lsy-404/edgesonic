# Read-only HTTP pressure run

The harness sends only `GET` requests to the library stats route and Subsonic `search3` route. It ramps concurrency through 1, 5, 10, 20, and 40, with 20 requests at each stage by default. Each run is capped at 2,500 requests total. It stops ramping after 3 rate-limit/5xx/transport/timeout errors in a stage or when stage p95 reaches 3 seconds.

Set credentials in the invoking shell and pass an authorized base URL; the harness never prints headers, cookies, query strings, or response bodies:

```powershell
$env:PRESSURE_BASE_URL = 'https://authorized-host.example'
$env:PRESSURE_HEADERS_JSON = '{"authorization":"Bearer <token>"}'
$env:PRESSURE_COOKIE = '<session-cookie>'
node scripts/http-pressure.mjs --scenario=mixed --requests=20
```

Use `--scenario=stats`, `--scenario=search3`, or `--scenario=mixed`. Search runs cycle `songCount` values 20, 100, and 500. Override bounds with `--requests=`, `--timeout-ms=`, `--error-threshold=`, and `--p95-abort-ms=`; requests per stage are limited to 500, timeout to 30 seconds, and concurrency stages remain fixed. `PRESSURE_HEADERS_JSON`, `PRESSURE_COOKIE`, and `PRESSURE_BASE_URL` can be supplied by a secrets-aware shell or runner. Each JSON output line summarizes one stage, with per-endpoint latency percentiles, successes, HTTP status/error classes, rate limits, and optional Server-Timing/Cloudflare colo observations.

Run local harness tests with `node --test test/http-pressure.test.mjs`.
