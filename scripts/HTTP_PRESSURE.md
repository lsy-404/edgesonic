# Read-only HTTP pressure run

The harness sends only `GET` requests to the library stats route and Subsonic `search3` route. Search uses an empty query by default (full library listing), requests no artist or album rows, and cycles song page sizes 20, 100, and 500 with oldest/newest sort orders. Set `PRESSURE_QUERY` to benchmark a specific term. Search authentication can use `PRESSURE_API_KEY` and optional `PRESSURE_USERNAME`; stats authentication can use headers or a session cookie. The harness never echoes the URL or credentials.

It ramps concurrency through 1, 5, 10, 20, and 40, with 20 requests at each stage by default. Each run is capped at 2,500 requests total. It stops ramping on authentication failures, after 3 rate-limit/other 4xx/5xx/protocol/transport/timeout errors in a stage, or when stage end-to-end p95 reaches 3 seconds. End-to-end timing consumes the response body (capped at 4 MiB); TTFB is reported separately. A successful HTTP response must contain `ok: true` for stats or a Subsonic JSON envelope with `status: "ok"` for search.

Set credentials in the invoking shell and pass an authorized base URL; the harness never prints headers, cookies, query strings, or response bodies:

```powershell
$env:PRESSURE_BASE_URL = 'https://authorized-host.example'
$env:PRESSURE_HEADERS_JSON = '{"authorization":"Bearer <token>"}'
$env:PRESSURE_COOKIE = '<session-cookie>'
$env:PRESSURE_API_KEY = '<api-key>'
$env:PRESSURE_USERNAME = 'readonly-user'
node scripts/http-pressure.mjs --scenario=mixed --requests=20
```

Use `--scenario=stats`, `--scenario=search3`, or `--scenario=mixed`. Override bounds with `--requests=`, `--timeout-ms=`, `--error-threshold=`, and `--p95-abort-ms=`; requests per stage are limited to 500, timeout to 30 seconds, and concurrency stages remain fixed. Credentials should come from a secrets-aware shell or runner. Each JSON output line summarizes one stage, with per-endpoint end-to-end and TTFB percentiles, successes, HTTP status/error classes, rate limits, and optional Server-Timing/Cloudflare colo observations.

Run local harness tests with `node --test test/http-pressure.test.mjs`.
