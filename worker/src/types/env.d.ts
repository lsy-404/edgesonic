// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

interface Env {
  DB: D1Database;
  MUSIC_BUCKET: R2Bucket;
  // Rendezvous point for the push-based work pool: browsers hold a socket
  // here and newly queued rows are handed straight down it. Optional so a
  // deployment whose wrangler.toml predates the binding keeps working — every
  // call site treats its absence as "poll path only".
  WORK_COORDINATOR?: DurableObjectNamespace;
  // Cloudflare Images binding — resizes cover art on demand in getCoverArt.
  IMAGES: ImagesBinding;
  ASSETS: Fetcher;
  INSTANCE_ID: string;
  MAX_PROXY_DEPTH?: string;
  // (pushed dynamically via /edgesonic/cf/setToken using the CF API itself,
  // not declared in wrangler.toml). Unset until the admin runs first-time
  // setup from the Settings page.
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  //  wrangler secret put WORK_UPLOAD_HMAC_KEY
  // (≥32 random bytes, e.g. `openssl rand -base64 48`). Unset → falls back
  // to INSTANCE_ID + static salt; see worker/src/utils/workUploadToken.ts.
  WORK_UPLOAD_HMAC_KEY?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  // Optional GitHub token for the self-update release lookup:
  //  wrangler secret put GITHUB_TOKEN
  // Unset → unauthenticated calls, capped at 60/hour per source IP and shared
  // with every other tenant on the same Cloudflare egress address, which
  // GitHub reports as HTTP 403. A fine-grained token with no scopes (public
  // repo read is enough) raises the cap to 5000/hour. See utils/autoupdate.ts.
  GITHUB_TOKEN?: string;
  // can detect a deploy without a hard refresh. Bump per deploy via either:
  //  - wrangler.toml [vars] WORKER_VERSION = "<label>" (default; bump before deploy)
  //  - `wrangler deploy --var WORKER_VERSION:$(date +%s)` (one-shot override)
  // Unset → endpoint returns "0".
  WORKER_VERSION?: string;
  EDGESONIC_VERSION?: string;
  EDGESONIC_BUILD_TIME?: string;
  // push secrets into this same Worker. Defaults to "edgesonic" when unset so
  // existing deployments keep working without a redeploy.
  WORKER_NAME?: string;
  // feature `enable_r2_presign` is '1', the /rest/stream raw+r2 branch
  // 302-redirects the browser to a short-lived presigned R2 S3 URL,
  // bypassing the Worker sub-request bandwidth pool. The R2 account id
  // is read from `CF_ACCOUNT_ID` (already pushed as a Workers Secret by
  // the Settings → Cloudflare integration sub-block) — no
  // separate R2_ACCOUNT_ID secret is needed. Push via:
  //  wrangler secret put R2_ACCESS_KEY_ID
  //  wrangler secret put R2_SECRET_ACCESS_KEY
  // See worker/SECRETS.md §3.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // Permission matrix cache, pushed dynamically via
  // POST /edgesonic/permissions/save using the same CF-API-secret-write
  // pattern as CF_API_TOKEN (cf.ts:setToken) — no redeploy needed. JSON
  // shape: `{ [level: string]: { [permission: string]: boolean } }`.
  // Read before D1 in permissionMiddleware/hasPermission (utils/
  // permissions.ts); D1's user_permissions.enabled column is the fallback
  // when this is unset or fails to parse.
  PERMISSIONS_OVERRIDE?: string;
  // Mirrors [[r2_buckets]] bucket_name in wrangler.toml — R2Bucket bindings
  // don't expose their own bucket name at runtime. Used for the read-only R2
  // detail card in Sources.vue, and as the bucket name signed into R2
  // presigned URLs in media.ts (falls back to "edgesonic-music" when unset,
  // matching every deployment from before this var existed).
  R2_BUCKET_NAME?: string;
  // Post-deploy cron auto-recovery state, pushed dynamically as a Workers
  // Secret via the CF API (same mechanism as CF_API_TOKEN / PERMISSIONS_OVERRIDE
  // — no redeploy needed). JSON shape: `{ "crons": string[], "build": string }`
  // where `build` is the WORKER_VERSION cron was last applied under. Read as the
  // fast primary (a Secret survives `wrangler deploy`); the kv_store D1 row
  // `cron_recovery_state` is the durable backup. See utils/cronRecovery.ts.
  CRON_STATE?: string;
  // Demo mode. Set DEMO_MODE="1" in [vars] to engage. The Worker then
  // locks superadmin password changes, disables dangerous permissions and
  // feature flags, and caps upload size. Periodic D1/R2 reset is handled by
  // the deploy-demo GitHub workflow, NOT the Worker. See
  // worker/src/utils/demoMode.ts.
  DEMO_MODE?: string;
  // Per-upload byte ceiling in demo mode (default 50 MiB). Enforced by the
  // Worker at the /files/upload and /work/upload endpoints.
  DEMO_MAX_UPLOAD_BYTES?: string;
  // Total R2 storage ceiling in bytes. Applies in BOTH normal and demo
  // modes. Normal mode: read from this env var first, else fall back to
  // the D1 feature_strings row "r2_max_storage_bytes". Demo mode: same
  // resolution, but the feature_strings row is also locked against edits
  // via DEMO_LOCKED_FEATURE_KEYS so a visitor can't lift the cap. 0
  // disables the cumulative guard (per-upload cap still applies in demo).
  R2_MAX_LIMIT?: string;
  // Default UI theme id. When set, the SPA applies this theme on first
  // visit (before the user picks their own). Resolution: env.DEFAULT_THEME
  // → D1 feature_strings row "default_theme" → unset (SPA uses "black").
  // Demo mode locks the D1 row against edits.
  DEFAULT_THEME?: string;
  // Whether /files/upload accepts any file type ("1") or only audio
  // extensions ("0"). Resolution: env.ALLOW_ALL_FILE_TYPES → D1
  // feature_strings row "allow_all_file_types" → "0" (audio-only).
  // Demo mode locks the D1 row against edits so a visitor can't upload
  // arbitrary payloads.
  ALLOW_ALL_FILE_TYPES?: string;
}
