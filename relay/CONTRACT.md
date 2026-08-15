# Installer CORS Relay — Contract

Context: `installer/` (a static GitHub Pages site) cannot call `api.cloudflare.com` directly from the
browser — confirmed by a live probe, Cloudflare's API sends no `Access-Control-Allow-*` headers on any
method, including `OPTIONS` preflight. This relay is a small Worker, deployed on the project's own
Cloudflare account, whose only job is: forward an allow-listed set of Cloudflare API calls and add CORS
headers. It must never become a general-purpose open proxy.

Non-goals: no logging of `Authorization` headers or request/response bodies (Workers `console.log` calls
go to observability — do not log secrets, ever, even at debug level). No persistence — pure passthrough,
stateless.

## 1. Transparent CF API passthrough — `/cf/*`

Client calls `RELAY_URL/cf/<cf-api-path>` with the same method/body/`Authorization: Bearer <token>` header
it would send to `https://api.cloudflare.com/client/v4/<cf-api-path>` directly. The relay strips the `/cf`
prefix, validates the remaining path against the allowlist below, and forwards to
`https://api.cloudflare.com/client/v4/<cf-api-path>` unchanged otherwise (method, headers except Host,
body). Response is passed back with CORS headers added; JSON body untouched.

Reject (403, no upstream call) anything not matching this allowlist. Match on method + path *pattern*
(`{accountId}`, `{scriptName}`, `{dbId}`, `{zoneId}` are opaque path segments — validate they're
non-empty and contain no `/`, don't further validate their format):

| Method | Path pattern | Used for |
|---|---|---|
| GET | `/user/tokens/verify` | token sanity check |
| GET | `/accounts/{accountId}` | token validity + account name display |
| GET | `/accounts/{accountId}/r2/buckets` | R2 enabled? + list existing |
| POST | `/accounts/{accountId}/r2/buckets` | create bucket (fresh install) |
| GET | `/accounts/{accountId}/d1/database` | list D1 databases |
| POST | `/accounts/{accountId}/d1/database` | create D1 database |
| POST | `/accounts/{accountId}/d1/database/{dbId}/query` | apply Schema.sql, insert superadmin |
| GET | `/accounts/{accountId}/workers/scripts` | detect name collision (overwrite vs fresh) |
| GET | `/accounts/{accountId}/workers/scripts/{scriptName}` | script metadata (overwrite install) |
| GET | `/accounts/{accountId}/workers/scripts/{scriptName}/deployments` | current live version (overwrite/rollback) |
| POST | `/accounts/{accountId}/workers/scripts/{scriptName}/versions` | upload new Worker version (multipart) |
| POST | `/accounts/{accountId}/workers/scripts/{scriptName}/deployments` | switch traffic to new version |
| POST | `/accounts/{accountId}/workers/scripts/{scriptName}/assets-upload-session` | start static asset upload |
| PUT | `/accounts/{accountId}/workers/scripts/{scriptName}/secrets` | push `WORK_UPLOAD_HMAC_KEY`, `CF_ACCOUNT_ID` |
| GET | `/accounts/{accountId}/workers/scripts/{scriptName}/schedules` | read cron |
| PUT | `/accounts/{accountId}/workers/scripts/{scriptName}/schedules` | write cron (default `0 */1 * * *`) |
| GET | `/zones?name={domain}` | resolve zone for a custom domain (only if user supplied one) |
| POST | `/accounts/{accountId}/workers/assets/upload` (query `base64=true`) | upload asset bytes for the session |
| GET | `/accounts/{accountId}/images/v1/stats` | Images enabled? (call fails/errors when the account has no Images subscription; `result.count.{current,allowed}` on success) |
| GET | `/accounts/{accountId}/workers/domains` | list Custom Domains (detect existing binding before overwrite) |
| PUT | `/accounts/{accountId}/workers/domains` | attach a Custom Domain to the Worker in one call (`{ hostname, service, zone_id or zone_name, environment? }` — resolves the zone itself, no separate zone lookup + route needed) |

Verified against `developers.cloudflare.com`'s API reference on 2026-08-15 (Images Usage Statistics;
Workers Custom Domains list/update) — both match what this file originally described as "candidates to
confirm", so the allowlist above is final, not a placeholder.

## 2. R2 S3 key-pair verification — `POST /r2/verify-keys`

Separate from §1 — this does **not** go to `api.cloudflare.com`, it signs a request to R2's S3-compatible
endpoint (`https://{accountId}.r2.cloudflarestorage.com/...`), a different host with unknown CORS
behavior (not probed yet — assume no CORS, route through the relay rather than have the installer call it
directly).

Request body: `{ accountId: string, bucketName: string, accessKeyId: string, secretAccessKey: string }`.

Sequencing requirement (document this in the installer flow, not just here): the R2 **bucket** must
already exist (created via §1's `POST .../r2/buckets` using the CF API token) *before* this check runs —
validate the key pair with a signed request against that real bucket, not a list-buckets call (R2's S3
layer may not support account-root listing; a bucket-scoped `HEAD` mirrors the pattern already proven in
`docs/DEPLOY_BY_AGENT.md` §3.5.2).

Implementation: use `aws4fetch` (small, zero-dependency, purpose-built for signing AWS/S3-style requests
in `fetch`-based runtimes including Workers — don't hand-roll SigV4 HMAC signing). Sign a `HEAD` to
`https://{accountId}.r2.cloudflarestorage.com/{bucketName}` with region `auto`, service `s3`. Response:
`{ ok: true }` on HTTP 200, else `{ ok: false, status, message }` — do not leak the signed request's
internals or the secret key in the message.

## 3. CORS policy

- `Access-Control-Allow-Origin`: exact match against a small allowlist of installer origins (the published
  GitHub Pages URL(s) — support at least the production Pages URL; read the allowlist from a Worker var/
  secret so it can be updated without a code change). Do not reflect arbitrary `Origin` headers.
- `Access-Control-Allow-Methods`: `GET, POST, PUT, OPTIONS`
- `Access-Control-Allow-Headers`: `Authorization, Content-Type`
- Handle `OPTIONS` preflight for every route above.
- No credentials mode needed (no cookies involved — bearer tokens only), so
  `Access-Control-Allow-Credentials` should stay unset/false.

## 4. Size/abuse limits

- Reject request bodies over 20 MB (Worker asset upload chunks can be a few MB each; the multipart Worker
  version upload can be a few MB too — pick a ceiling comfortably above real payloads but well below
  Workers' own request body cap).
- No rate limiting beyond what Cloudflare Workers' own platform limits provide is required for v1 — this
  is a low-traffic installer tool, not a public API product. Note this as a known limitation rather than
  building a custom limiter.

## 5. Open questions

- The R2 bucket-scoped `HEAD` check (§2) confirms the key pair can reach *a* bucket it's scoped to, but an
  R2-scoped API token restricted to a *different* bucket name would also 200 on its own bucket and never
  get exercised against the one the installer just created if the user pastes mismatched
  bucket-name/key-pair combinations from two different buckets they own — the check as specified can't
  distinguish "wrong keys" from "right keys, wrong bucket" beyond what the HTTP status already reports.
  Not a relay change, just worth the installer surfacing the bucket name in the error message it shows
  on a non-200.
- No endpoint in the allowlist lets the installer delete/rollback a Workers version or R2 bucket it just
  created if a later step in the flow fails (e.g. D1 schema apply succeeds but secret push fails). Out of
  scope for this relay (it only forwards what it's told to), but the installer's own error-recovery UX
  should account for "partially provisioned account" as a state, since there's currently no automated
  cleanup path through this allowlist.
