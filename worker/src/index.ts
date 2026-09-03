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

import { Hono } from "hono";
import { authMiddleware, subsonicError } from "./auth";
import { replaceSubsonicServerVersion } from "./utils/xml";
import { registerRoutes } from "./router";
import { formPostMiddleware } from "./middleware/form_post";
import { formatMiddleware, xmlToJson } from "./middleware/format";
import { crossOriginIsolationMiddleware } from "./middleware/cross_origin_isolation";
import { apiRateLimitMiddleware } from "./middleware/rate_limit";
import { refreshAllChannels } from "./utils/podcastSync";
import { maybeRunScheduledScan } from "./utils/scheduledScan";
import { reclaimStaleWork } from "./utils/workReclaim";
import { maybeRunMetadataRecheck } from "./utils/metadataRecheck";
import { maybeRunLrcBackfill } from "./utils/lrcBackfill";
import { maybeRunArtistScrapeBackfill } from "./utils/artistScrapeBackfill";
import { maybeRunPeerSync } from "./utils/peerSync";
import { reapExpiredGuestTokens } from "./utils/guestTokenReaper";
import { maybeRunCacheEviction } from "./utils/cacheEviction";
import { webLoginRoutes } from "./endpoints/edgesonic/auth";
import { sharePublicRoutes } from "./endpoints/share_public";

// Durable Object backing SandboxTranscodeEngine. This export must exist even
// when the engine is not in use (containers binding is declared in wrangler.toml).
export { Sandbox } from "@cloudflare/sandbox";

// Rendezvous point for the push-based work pool. Browsers on the work-mode
// page hold a socket here; newly queued tasks are handed straight down it
// the moment they are queued.
export { WorkCoordinator } from "./coordinator/workCoordinator";

const app = new Hono();

// ./middleware/cross_origin_isolation so the test suite can import it without
// dragging in the @cloudflare/sandbox container binding from this file's
// top-level re-export.
app.use("*", crossOriginIsolationMiddleware);

// Legacy management routes also return Subsonic XML but do not pass through
// the /rest format middleware. Normalize their envelope version here.
app.use("*", async (c, next) => {
  await next();
  if (!(c.res.headers.get("Content-Type") || "").includes("xml")) return;
  const xml = await c.res.text();
  if (!xml.includes("serverVersion=")) {
    c.res = new Response(xml, { status: c.res.status, headers: c.res.headers });
    return;
  }
  c.res = new Response(replaceSubsonicServerVersion(xml, (c.env as Env).EDGESONIC_VERSION), {
    status: c.res.status,
    headers: c.res.headers,
  });
});

// has to run BEFORE any auth filter. Mounted on the bare app at
// /edgesonic/auth/login + /logout.
app.route("/", webLoginRoutes);

// anonymous visitors can press play on a share link without credentials.
app.route("/", sharePublicRoutes);

// OR application/x-www-form-urlencoded body. Merge any form body fields into
// the URL query BEFORE auth & route handlers run, so all existing
// `c.req.query()` / `c.req.queries()` call sites pick them up transparently.
// The middleware is still scoped to /rest/* because that's the only surface
// where Subsonic clients submit form-encoded bodies; the management buckets
// (/tag /storage /edgesonic) only accept JSON.
app.use("/rest/*", formPostMiddleware);

// occasionally request /rest/ping/ with a trailing slash. Hono's route
// matching is strict on trailing slashes, so /rest/ping/ would miss the
// /rest/ping route and fall through to 401 (auth middleware) or 404.
// Normalize: strip a single trailing slash from /rest/* paths before any
// auth or route logic runs. Only strips the LAST slash (not path components).
app.use("/rest/*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.endsWith("/") && url.pathname !== "/rest/") {
    url.pathname = url.pathname.replace(/\/$/, "");
    return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
  }
  return next();
});

// trailing-slash normalizer (so a re-dispatched request converts exactly
// once) and BEFORE authMiddleware, so auth-failure XML envelopes are
// converted too — a JSON client must never receive an XML error body.
app.use("/rest/*", formatMiddleware);

// strategy inside authMiddleware picks the right policy:
//   /rest/*     → Subsonic token+salt / apiKey / guestToken
//  /tag /storage /edgesonic → web-session credential only
app.use("/rest/*", authMiddleware);
app.use("/tag/*", authMiddleware);
app.use("/storage/*", authMiddleware);
app.use("/edgesonic/*", authMiddleware);
app.use("/rest/*", apiRateLimitMiddleware);
app.use("/tag/*", apiRateLimitMiddleware);
app.use("/storage/*", apiRateLimitMiddleware);
app.use("/edgesonic/*", apiRateLimitMiddleware);

registerRoutes(app);

app.onError((err, c) => {
  console.error(err);
  // the management buckets (/edgesonic /tag /storage) return JSON. Using
  // pathname (not c.req.url) so a query string containing "/rest/" can't
  // trick a management error into rendering as XML.
  const isSubsonic = new URL(c.req.url).pathname.startsWith("/rest/");
  if (isSubsonic) {
    // rejects before it can transform), so honor f=json/jsonp here directly.
    const xml = replaceSubsonicServerVersion(subsonicError(0, err.message), (c.env as Env).EDGESONIC_VERSION);
    const format = (c.req.query("f") || "xml").toLowerCase();
    if (format === "json" || format === "jsonp") {
      const json = JSON.stringify(xmlToJson(xml));
      return format === "jsonp"
        ? c.text(`${c.req.query("callback") || "cb"}(${json});`, 200, {
            "Content-Type": "application/javascript; charset=UTF-8",
          })
        : c.text(json, 200, { "Content-Type": "application/json; charset=UTF-8" });
    }
    return c.text(xml, 200, { "Content-Type": "application/xml; charset=UTF-8" });
  }
  return c.json({ ok: false, error: err.message }, 500);
});

// expression lives in wrangler.toml; this handler is what the Cloudflare
// runtime invokes for each tick. We use ctx.waitUntil so any failures inside
// refreshAllChannels (network blips, parse errors) don't crash the worker
// per-channel errors are recorded into the channel row instead.
//
// scan_interval_hours + cron:last_scan_ts to decide whether to dispatch a new
// asyncScanSource per enabled source. Independent ctx.waitUntil() calls let
// either subsystem fail without blocking the other.
export default {
  fetch: app.fetch.bind(app),
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      refreshAllChannels(env.DB).catch((e) => {
        console.error("scheduled refreshAllChannels failed:", e);
      }),
    );
    ctx.waitUntil(
      maybeRunScheduledScan(env, ctx).catch((e) => {
        console.error("scheduled maybeRunScheduledScan failed:", e);
      }),
    );
    // that went offline mid-task doesn't lock the row forever.
    ctx.waitUntil(
      reclaimStaleWork(env).catch((e) => {
        console.error("scheduled reclaimStaleWork failed:", e);
      }),
    );
    // worker's embedded parser couldn't read (other formats) or that are
    // missing lyrics/disc despite the album already having a cover.
    ctx.waitUntil(
      maybeRunMetadataRecheck(env, ctx).catch((e) => {
        console.error("scheduled maybeRunMetadataRecheck failed:", e);
      }),
    );
    // Batch-scan song_masters still missing lyrics for a sibling .lrc
    // file. Independent of maybeRunMetadataRecheck: this never touches
    // work_queue, it reads directly from R2/WebDAV and writes D1 in place.
    ctx.waitUntil(
      maybeRunLrcBackfill(env, ctx).catch((e) => {
        console.error("scheduled maybeRunLrcBackfill failed:", e);
      }),
    );
    // Batch backfill artists missing biography / image_url from
    // netease/qmusic. Independent cadence (artist_scrape_interval_hours).
    ctx.waitUntil(
      maybeRunArtistScrapeBackfill(env, ctx).catch((e) => {
        console.error("scheduled maybeRunArtistScrapeBackfill failed:", e);
      }),
    );
    // Per-user one-peer favourite/playlist reconciliation. Self-gates to at
    // most once per hour via cron:last_peer_sync_ts (independent of the scan's
    // own gate), so it pulls hourly regardless of how often the cron ticks.
    ctx.waitUntil(
      maybeRunPeerSync(env).catch((e) => {
        console.error("scheduled maybeRunPeerSync failed:", e);
      }),
    );
    // Reap expired guest tokens. Cheap single DELETE; runs every tick so the
    // table doesn't accumulate dead rows between scans.
    ctx.waitUntil(
      reapExpiredGuestTokens(env).catch((e) => {
        console.error("scheduled reapExpiredGuestTokens failed:", e);
      }),
    );
    // proactively clear past-TTL cached rows for every source with a
    // cache_tier, so budget-under sources still get reclaimed instead of
    // only evicting reactively at the next cache write.
    ctx.waitUntil(
      maybeRunCacheEviction(env, ctx).catch((e) => {
        console.error("scheduled maybeRunCacheEviction failed:", e);
      }),
    );
  },
};
