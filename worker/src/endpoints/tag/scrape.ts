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
import type { User } from "../../types/entities";
import { proxyFetch } from "../../../../shared/scrape/transport";

// ============================================================================
//
// All three routes are SESSION_ONLY (see auth.ts). They emit JSON, not XML,
// because they belong to the web-side admin surface — Subsonic clients have
// no use for them.
//
//   POST /rest/scrapeMetadata      — proxy outbound fetch to external API
//                                    (NetEase / QQ / Kugou) so the browser
//                                    can bypass CORS + Referer checks.
//   POST /rest/submitScrapeResult  — record one audit row in scrape_jobs.
//                                    Does NOT auto-apply: the result is
//                                    pushed into TagEditor's form, then the
//                                    user saves via the writeTags
//                                    chain. We just remember which result
//                                    was chosen for which song.
//   GET  /rest/getScrapeHistory    — paginated history for the calling user.
// ============================================================================

export const scrapeRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// Outbound timeout / UA live in utils/scrapeFetch.ts.

// Per-user history page cap. The UI defaults to 30; admins can override via
// `?limit=`. We bound it server-side so a malicious caller can't pull the
// whole table in one shot.
const HISTORY_PAGE_MAX = 200;

type ScrapeSource = "lrc" | "netease" | "qmusic" | "kugou" | "kuwo" | "migu";
const VALID_SOURCES: ReadonlySet<ScrapeSource> = new Set([
  "lrc",
  "netease",
  "qmusic",
  "kugou",
  "kuwo",
  "migu",
]);

interface ProxyBody {
  source?: ScrapeSource;
  // Two mutually-exclusive shapes:
  //  { query } → search by free-text title+artist
  //  { songId } → fetch detail/lyric by upstream ID (returned in a prior search)
  query?: string;
  songId?: string;
  // optional intent: 'search' (default) | 'lyric' | 'detail'
  intent?: "search" | "lyric" | "detail";
}

interface SubmitBody {
  songMasterId?: string;
  source?: ScrapeSource;
  songId?: string;
  query?: string;
  // ScrapeResult shape from the browser; we forward verbatim to JSON column.
  result?: Record<string, unknown>;
  mode?: "tags" | "cover" | "both";
}

// ---------------------------------------------------------------------------
// POST /rest/scrapeMetadata
// Body: { source, query | songId, intent? }
// ---------------------------------------------------------------------------
scrapeRoutes.post("/scrape", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ ok: false, error: "Auth required" }, 401);

  let body: ProxyBody;
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.source || !VALID_SOURCES.has(body.source)) {
    return c.json({ ok: false, error: "Unknown or missing source" }, 400);
  }
  const intent = body.intent || "search";
  if (intent === "search" && !body.query) {
    return c.json({ ok: false, error: "Missing query for search intent" }, 400);
  }
  if ((intent === "lyric" || intent === "detail") && !body.songId) {
    return c.json({ ok: false, error: "Missing songId for lyric/detail intent" }, 400);
  }

  try {
    const proxied = await proxyFetch(body.source, intent, body);
    return c.json({ ok: true, source: body.source, intent, data: proxied });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Truncate to keep the response small — upstream HTML error pages can be huge.
    return c.json({ ok: false, error: msg.slice(0, 300) }, 502);
  }
});

// ---------------------------------------------------------------------------
// POST /rest/submitScrapeResult
// Body: { songMasterId?, source, songId?, query?, result, mode }
// Always inserts; status='applied' on success path, 'failed' if we caught.
// ---------------------------------------------------------------------------
scrapeRoutes.post("/submitScrape", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ ok: false, error: "Auth required" }, 401);

  let body: SubmitBody;
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.source || !VALID_SOURCES.has(body.source)) {
    return c.json({ ok: false, error: "Unknown or missing source" }, 400);
  }
  if (!body.result || typeof body.result !== "object") {
    return c.json({ ok: false, error: "Missing result payload" }, 400);
  }
  const mode = body.mode || "tags";
  if (!["tags", "cover", "both"].includes(mode)) {
    return c.json({ ok: false, error: "mode must be tags|cover|both" }, 400);
  }

  const db = c.env.DB;
  const id = "scrp-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  const now = Math.floor(Date.now() / 1000);

  // If a songMasterId was supplied, sanity-check it exists. We DON'T fail the
  // insert when it doesn't — the FK is ON DELETE SET NULL, so we just store
  // null instead. This keeps the audit row alive even if the user pasted a
  // stale ID.
  let masterId: string | null = body.songMasterId || null;
  if (masterId) {
    const exists = await db.prepare("SELECT id FROM song_masters WHERE id = ?")
      .bind(masterId).first<{ id: string }>();
    if (!exists) masterId = null;
  }

  let resultJson: string;
  try {
    resultJson = JSON.stringify(body.result);
  } catch {
    return c.json({ ok: false, error: "result is not JSON-serialisable" }, 400);
  }
  // Cap row payload — D1 has a 1MB row limit; a search result is < 2KB realistically.
  if (resultJson.length > 64 * 1024) {
    return c.json({ ok: false, error: "result payload too large (>64KB)" }, 400);
  }

  await db.prepare(
    `INSERT INTO scrape_jobs
       (id, user_id, song_master_id, source, query, remote_song_id, result_json, status, mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`
  ).bind(
    id,
    user.username,
    masterId,
    body.source,
    body.query || null,
    body.songId || null,
    resultJson,
    mode,
    now,
  ).run();

  return c.json({ ok: true, id, status: "applied", songMasterId: masterId });
});

// ---------------------------------------------------------------------------
// GET /rest/getScrapeHistory
// Query: ?limit=30&offset=0&songMasterId=…(optional filter)
// ---------------------------------------------------------------------------
scrapeRoutes.get("/scrapeHistory", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ ok: false, error: "Auth required" }, 401);

  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || "30", 10) || 30, 1),
    HISTORY_PAGE_MAX,
  );
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
  const masterFilter = c.req.query("songMasterId");

  const where = ["user_id = ?"];
  const args: Array<string | number> = [user.username];
  if (masterFilter) {
    where.push("song_master_id = ?");
    args.push(masterFilter);
  }

  const sql = `SELECT id, song_master_id, source, query, remote_song_id, result_json,
                      status, mode, error_message, created_at
                 FROM scrape_jobs
                WHERE ${where.join(" AND ")}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...args, limit, offset)
    .all<{
      id: string;
      song_master_id: string | null;
      source: string;
      query: string | null;
      remote_song_id: string | null;
      result_json: string | null;
      status: string;
      mode: string | null;
      error_message: string | null;
      created_at: number;
    }>();

  // Parse result_json so the UI doesn't have to. Bad JSON (shouldn't happen)
  // gracefully degrades to a string field.
  const items = (rows.results || []).map((r) => {
    let result: unknown = null;
    if (r.result_json) {
      try { result = JSON.parse(r.result_json); } catch { result = r.result_json; }
    }
    return {
      id: r.id,
      songMasterId: r.song_master_id,
      source: r.source,
      query: r.query,
      remoteSongId: r.remote_song_id,
      result,
      status: r.status,
      mode: r.mode,
      errorMessage: r.error_message,
      createdAt: r.created_at,
    };
  });

  return c.json({ ok: true, items, limit, offset });
});

// ===========================================================================
// Outbound fetch dispatch — per-source URL + headers shape.
//
// Each external service refuses cross-origin requests from a browser
// (Referer / CORS), so we proxy from the Worker. Every fetch carries the
// upstream's expected Referer + a real-browser User-Agent. We never forward
// the EdgeSonic session token — the upstream is a public anonymous API.
// ===========================================================================
