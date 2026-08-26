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

//
// These are one-shot admin tools for tidying up the database state, not part
// of any user-facing protocol. Each endpoint is super-admin only (level >= 3)
// and safe to re-run (idempotent / "no-op when nothing to do").
//
// First endpoint: cleanupDuplicateCovers.
//  Background: the old getCoverArt fallback path (resolveAlbumCover)
//  would write the same parent-directory cover.jpg to a distinct R2 key per
//  album, so a folder hosting 25 albums ended up with 25 R2 keys whose
//  *contents* were identical (one anime character shown for every album).
//  That fallback is gone now, but the 25 historical keys are still bound to
//  their albums in D1. This endpoint releases all but one binding per
//  duplicate key, letting each freed album re-resolve its own cover on the
//  next /rest/getCoverArt call (which now correctly 404s if no per-album
//  cover exists, prompting <img onerror> to fall back to the UI placeholder
//  — the desired behaviour).
//
// We do NOT delete the R2 objects: the survivor row in each group still
//  needs the bytes. R2 lifecycle / orphan sweep is a separate concern.

import { Hono } from "hono";
import type { User } from "../../types/entities";
import { getFeatureString } from "../../utils/features";
import { permissionMiddleware } from "../../auth";
import { deriveBitrate, bitrateNeedsRepair } from "../../utils/audioMetrics";
import { sniffImageMime, resolveImageMime } from "../../utils/imageType";
import { getSourceCredentials } from "../../adapters/index";
import { wakePool } from "./work";
import { applyHistoricalSongDedupe, previewHistoricalSongDedupe } from "../../utils/historicalSongDedupe";

export const maintenanceRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// POST /edgesonic/maintenance/dedupeHistoricalSongs
// Body: { apply?: boolean }. Without apply=true this is a read-only preview.
// Matching is exclusively by identical storage_uri; title, artist, and album
// metadata are never used to infer a duplicate. The D1-only operation keeps
// one metadata-rich master, migrates references, and never deletes storage.
maintenanceRoutes.post("/maintenance/dedupeHistoricalSongs",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
    const body = await c.req.json<{ apply?: boolean }>().catch((): { apply?: boolean } => ({}));
    const applied = body.apply === true;
    const result = applied
      ? await applyHistoricalSongDedupe(c.env.DB)
      : await previewHistoricalSongDedupe(c.env.DB);
    return c.json({ ok: true, applied, ...result });
  },
);

// hardcoded level check was replaced by permissionMiddleware against three
// new permission rows (maintenance_cleanup / maintenance_reclaim /
// maintenance_reset, see migration 0024) so operators can delegate the
// tooling to L2 admins via the Permissions UI without a code change.

// ---------------------------------------------------------------------------
// POST /edgesonic/maintenance/cleanupDuplicateCovers
// ---------------------------------------------------------------------------
// Response: { ok: true, groups, cleared }
//  - groups: number of distinct cover_r2_key values that had >1 album
//  - cleared: number of albums whose cover_r2_key was set to NULL
//
// Algorithm:
//  1. SELECT cover_r2_key, COUNT(*) FROM albums GROUP BY ... HAVING n > 1
//  2. For each duplicated key, SELECT ids ORDER BY id ASC.
//    Survivor = ids[0]; the rest get cover_r2_key=NULL.
//
// Why "id ASC" as the survivor rule? Stable + deterministic + matches the
// `id` we generate during scan (which itself is created-order-ish), so the
// album that was created first keeps the cover binding. A future variant
// could pick by song_count or updated_at, but the simplest tie-break is also
// the easiest to reason about during recovery.
maintenanceRoutes.post("/maintenance/cleanupDuplicateCovers",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;

  // Aggregate the duplicate cover_r2_key values. We deliberately skip rows
  // where cover_r2_key IS NULL — those are albums without a cover at all and
  // they're not the problem.
  const dupes = (await env.DB.prepare(
    `SELECT cover_r2_key AS cover_r2_key, COUNT(*) AS n
     FROM albums
     WHERE cover_r2_key IS NOT NULL
     GROUP BY cover_r2_key
     HAVING n > 1
     ORDER BY n DESC`,
  ).all<{ cover_r2_key: string; n: number }>()).results;

  if (dupes.length === 0) {
    return c.json({ ok: true, groups: 0, cleared: 0 });
  }

  let cleared = 0;
  for (const dup of dupes) {
    // Pull the album ids that share this cover key, oldest first. We can't
    // use GROUP_CONCAT here because we need ORDER BY id ASC to pick a stable
    // survivor; a separate SELECT is the cheapest correct form.
    const ids = (await env.DB.prepare(
      `SELECT id
       FROM albums
       WHERE cover_r2_key = ?
       ORDER BY id ASC`,
    ).bind(dup.cover_r2_key).all<{ id: string }>()).results;

    // Defensive: a race could have rewritten the binding between the two
    // queries. If only one row remains, skip — nothing duplicated anymore.
    if (ids.length < 2) continue;

    // ids[0] is the survivor; release the rest. We could do an `IN (?,?,?)`
    // but D1's bind parameter limit (100) plus the fact that we'd need to
    // build the placeholder list dynamically makes a per-row UPDATE simpler
    // and not much slower (each group is ~25 rows max in practice).
    for (let i = 1; i < ids.length; i++) {
      const result = await env.DB.prepare(
        `UPDATE albums
         SET cover_r2_key = NULL,
             updated_at = unixepoch()
         WHERE id = ? AND cover_r2_key = ?`,
      ).bind(ids[i].id, dup.cover_r2_key).run();
      // Only count rows we actually changed — if another process raced us
      // (e.g. an admin manually re-bound the cover during the sweep) the
      // WHERE-constrained UPDATE turns into a no-op.
      if (result.meta.changes > 0) cleared++;
    }
  }

  return c.json({ ok: true, groups: dupes.length, cleared });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/maintenance/reclaimStaleWork
// ---------------------------------------------------------------------------
// scheduled handler. Useful when the CF Worker has no cron schedules (the
// dynamic-cron path was never run with ensureDefaultCron after a deploy)
// and browser workers have left rows stuck in 'claimed' with stale heartbeats.
//
// Response: { ok, reclaimed, requeued, failed, items: [{ id, status, attempts }] }
//  - reclaimed: total rows mutated (requeued + failed)
//  - requeued: rows whose attempts<max_attempts → status='queued'
//   - failed:  rows whose attempts>=max_attempts → status='failed' terminal
//   - items:   the per-row breakdown (capped naturally by the stale set)
//
// We use a single UPDATE … RETURNING so the read and the write happen against
// a consistent snapshot — without RETURNING we'd risk reclaiming rows that
// changed status between the SELECT and the UPDATE.
maintenanceRoutes.post("/maintenance/reclaimStaleWork",
  permissionMiddleware("maintenance_reclaim"),
  async (c) => {
  const env = c.env as Env;

  // Feature key was registered in 052a (default 60s) — the same one workReclaim
  // reads, so the manual button reuses the operator's tuning.
  const raw = await getFeatureString(env, "worker_claim_ttl_seconds", "60");
  const parsed = parseInt(raw, 10);
  const ttl = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;

  // Mirror workReclaim's branching: bucket by attempts vs max_attempts. The
  // CASE expressions on status and error_message make the two paths atomic in
  // one statement, and RETURNING surfaces the post-update row so the response
  // can show the operator exactly what happened.
  //
 // We keep the error_message wording aligned with workReclaim.ts so the
  // /work/status feed reads identically for cron-driven and manually-driven
  // reclaims (an operator inspecting failed rows shouldn't have to guess
  // whether the sweep was automatic).
  const result = await env.DB.prepare(
    `UPDATE work_queue
     SET status = CASE
                    WHEN attempts >= max_attempts THEN 'failed'
                    ELSE 'queued'
                  END,
         claimed_by = NULL,
         claimed_at = NULL,
         heartbeat_at = NULL,
         error_message = CASE
                           WHEN attempts >= max_attempts
                             THEN COALESCE(error_message, 'stale claim: max attempts exceeded')
                           ELSE COALESCE(error_message, 'stale claim re-queued')
                         END
     WHERE status = 'claimed'
       AND heartbeat_at IS NOT NULL
       AND heartbeat_at < unixepoch() - ?
     RETURNING id, status, attempts`,
  ).bind(ttl).all<{ id: string; status: string; attempts: number }>();

  const items = result.results || [];
  let requeued = 0;
  let failed = 0;
  for (const row of items) {
    if (row.status === "queued") requeued++;
    else if (row.status === "failed") failed++;
  }
  return c.json({
    ok: true,
    reclaimed: items.length,
    requeued,
    failed,
    ttlSeconds: ttl,
    items,
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/maintenance/resetFailedWork
// ---------------------------------------------------------------------------
//  When a browser worker shipped a buggy bundle, every task it picked up
//  would burn through attempts (default max=3) and end up at status='failed'.
//  Subsequent scans INSERT OR IGNORE the same deterministic id, so the
//  failed row sticks around forever and no fresh worker ever gets a shot at
//  it. The legitimate (now updated) bundle therefore can't recover the
//  instance metadata until somebody manually flips the failed rows back to
//  queued. This endpoint is that flip.
//
// Query: task_type=<optional> — filter the reset to a single task type. Useful
//  for "I only want metadata tasks to retry, leave the scan failures alone".
// Response: { ok: true, reset, taskType? }
//   - reset:  number of rows whose status moved 'failed' → 'queued'
//  - taskType: echoes the filter when given (helpful in operator audit log)
//
// Why the wholesale reset (attempts=0, clear claimed_* / error_message)?
//  - attempts=0: a fresh bundle deserves a clean budget; otherwise the very
//   first hiccup re-fails it.
//  - claimed_by/claimed_at/heartbeat_at: failed rows shouldn't carry
//   stale-claim residue. Leaving them set would make a future workReclaim
//   sweep treat the row as "claimed but stale" and try to flip it back to
//   failed again — clearing is safer.
//  - error_message=NULL: the previous error doesn't apply to the retry; the
//   UI shows it as a fresh queued row.
//
// Idempotent: re-running with zero failed rows just returns reset=0.
maintenanceRoutes.post("/maintenance/resetFailedWork",
  permissionMiddleware("maintenance_reset"),
  async (c) => {
  const env = c.env as Env;

  // Optional filter — drop the param entirely if absent so the SQL stays
  // bind-arity-clean (avoids a "?" with no matching bind).
  const onlyTaskType = c.req.query("task_type");
  const where = onlyTaskType
    ? "status='failed' AND task_type=?"
    : "status='failed'";
  const stmt = env.DB.prepare(
    `UPDATE work_queue
     SET status='queued',
         attempts=0,
         error_message=NULL,
         claimed_by=NULL,
         claimed_at=NULL,
         heartbeat_at=NULL
     WHERE ${where}`,
  );
  const result = onlyTaskType
    ? await stmt.bind(onlyTaskType).run()
    : await stmt.run();

  // These rows just became runnable. Nothing pulls from the queue, so without
  // this the admin clicks "reset failed" and sees nothing happen until some
  // unrelated enqueue wakes the pool.
  if (result.meta.changes > 0) await wakePool(env);

  return c.json({
    ok: true,
    reset: result.meta.changes,
    ...(onlyTaskType ? { taskType: onlyTaskType } : {}),
  });
});

// ---------------------------------------------------------------------------
// GET /edgesonic/maintenance/webdavThroughput?id=<sm-...>&bytes=N
// ---------------------------------------------------------------------------
// leg in isolation. Fetches up to N bytes (default 4 MiB, max 32 MiB) of the
// song's webdav instance inside the Worker and discards them.
//
// Interpreting the result against what the browser observes on /rest/stream:
//   - originMBps low here too          → the origin / CF-to-origin route is
//                                        the bottleneck (hot cache is the fix)
//  - originMBps high, browser still slow → the sub-request bandwidth pool is
//                                        throttling the proxied stream
//                                        (hot cache / presign is the fix)
maintenanceRoutes.get("/maintenance/webdavThroughput",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;
  const id = c.req.query("id");
  if (!id) return c.json({ ok: false, error: "Missing id (song master id)" }, 400);
  const bytesParam = parseInt(c.req.query("bytes") || "0", 10) || 4 * 1024 * 1024;
  const bytes = Math.min(Math.max(bytesParam, 64 * 1024), 32 * 1024 * 1024);

  const inst = await env.DB.prepare(
    `SELECT storage_uri FROM song_instances
     WHERE master_id = ? AND storage_uri LIKE 'webdav://%' AND missing = 0
     LIMIT 1`,
  ).bind(id).first<{ storage_uri: string }>();
  if (!inst) return c.json({ ok: false, error: "No webdav instance for this id" }, 404);

  const { createWebDAVAdapter } = await import("../../adapters/webdav");
  const t0 = Date.now();
  const resp = await createWebDAVAdapter(env.DB, env).stream(inst.storage_uri, `bytes=0-${bytes - 1}`);
  if (!resp.body || resp.statusCode >= 400) {
    return c.json({ ok: false, error: `origin responded ${resp.statusCode}` }, 502);
  }
  const reader = resp.body.getReader();
  let received = 0;
  let ttfbMs: number | null = null;
  while (received < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfbMs === null) ttfbMs = Date.now() - t0;
    received += value.length;
  }
  await reader.cancel().catch(() => {});
  const elapsedMs = Date.now() - t0;
  const transferMs = Math.max(elapsedMs - (ttfbMs ?? 0), 1);

  return c.json({
    ok: true,
    uri: inst.storage_uri.replace(/^(webdav:\/\/[^/]+).*/, "$1/…"),
    requestedBytes: bytes,
    receivedBytes: received,
    ttfbMs,
    elapsedMs,
    originMBps: Number((received / 1024 / 1024 / (transferMs / 1000)).toFixed(2)),
  });
});

// ---------------------------------------------------------------------------
// GET /edgesonic/maintenance/orphanSongs
// ---------------------------------------------------------------------------
// "Orphan" = a song_masters row still parked under the /files/upload
// placeholder bucket (artist_id='unknown-artist' OR album_id='pending-uploads'
// — see files.ts's upload handler). applyMetadataResult (metadataApply.ts)
// is supposed to relink these to real artist/album once the browser worker
// pool parses tags, but it unconditionally sets tag_scanned=1 even when the
// parse came back empty (no usable tags) — so a file with no embedded
// metadata at all gets permanently stuck here indistinguishable from
// "still waiting to be scanned" without checking tag_scanned itself. This
// endpoint surfaces the whole stuck bucket so an admin can retry the scan
// (via the existing /tag/rescan) or just delete the dead weight.
//
// Response: { ok: true, songs: [{ masterId, title, createdAt, instanceCount,
//   suffix, totalSize, tagScanned, missing }] }
//  - tagScanned/missing are MAX() across a master's instances — "worst case"
//    (any instance still unscanned, or gone missing, surfaces as such).
maintenanceRoutes.get("/maintenance/orphanSongs",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;
  // Two kinds of orphans:
  //   1. upload-bucket masters left under the 'unknown-artist' /
  //      'pending-uploads' placeholders (the original scope of this tool);
  //   2. "ghost" masters with metadata but NO song_instances rows — every
  //      stream returns 404 even though the song shows up in search/album
  //      listings. Usually a leftover from an interrupted scan or a
  //      Subsonic clone whose instance rows were later reclaimed. Flagged
  //      with ghost=true so the UI can distinguish them from bucket orphans.
  const rows = (await env.DB.prepare(
    `SELECT sm.id AS master_id, sm.title, sm.album_id, sm.artist_id, sm.created_at,
            COUNT(si.id) AS instance_count,
            MIN(si.suffix) AS suffix,
            COALESCE(SUM(si.size), 0) AS total_size,
            MAX(si.tag_scanned) AS tag_scanned,
            MAX(si.missing) AS missing
     FROM song_masters sm
     LEFT JOIN song_instances si ON si.master_id = sm.id
     WHERE sm.artist_id = 'unknown-artist' OR sm.album_id = 'pending-uploads'
        OR NOT EXISTS (SELECT 1 FROM song_instances WHERE master_id = sm.id)
     GROUP BY sm.id
     ORDER BY sm.created_at DESC
     LIMIT 200`,
  ).all<{
    master_id: string; title: string; album_id: string; artist_id: string; created_at: number;
    instance_count: number; suffix: string | null; total_size: number;
    tag_scanned: number | null; missing: number | null;
  }>()).results;

  return c.json({
    ok: true,
    songs: rows.map((r) => ({
      masterId: r.master_id,
      title: r.title,
      albumId: r.album_id,
      artistId: r.artist_id,
      createdAt: r.created_at,
      instanceCount: r.instance_count,
      suffix: r.suffix,
      totalSize: r.total_size,
      tagScanned: r.tag_scanned ?? 0,
      missing: !!r.missing,
      ghost: r.instance_count === 0 && r.artist_id !== "unknown-artist" && r.album_id !== "pending-uploads",
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/maintenance/orphanSongs/delete  body: { masterIds: string[] }
// ---------------------------------------------------------------------------
// Deletes the underlying storage object(s) for every instance of each given
// master (best-effort — a storage-side failure doesn't block the D1 cleanup,
// mirroring /files/delete's "the DB record is the source of truth" stance),
// then the song_instances rows, then the song_masters row itself. Does NOT
// touch the shared 'unknown-artist'/'pending-uploads' placeholder rows —
// they're a reusable bucket for future uploads (INSERT OR IGNORE recreates
// them on demand), not per-song state.
//
// Only r2:// and webdav:// instances can come from the upload path this
// endpoint is meant to clean up; any other scheme (url/subsonic — external,
// read-only mounts) just gets its D1 rows dropped, no storage call.
//
// Response: { ok: true, deleted, failed, items: [{ masterId, ok, error? }] }
const ORPHAN_DELETE_MAX = 200;
maintenanceRoutes.post("/maintenance/orphanSongs/delete",
  permissionMiddleware("delete"),
  async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ masterIds?: string[] }>().catch(() => ({ masterIds: [] as string[] }));
  const masterIds = (body.masterIds || []).slice(0, ORPHAN_DELETE_MAX);
  if (masterIds.length === 0) {
    return c.json({ ok: false, error: "Missing masterIds" }, 400);
  }

  const items: Array<{ masterId: string; ok: boolean; error?: string }> = [];
  for (const masterId of masterIds) {
    try {
      const instances = (await env.DB.prepare(
        "SELECT storage_uri FROM song_instances WHERE master_id = ?",
      ).bind(masterId).all<{ storage_uri: string }>()).results;

      for (const inst of instances) {
        try {
          if (inst.storage_uri.startsWith("r2://")) {
            await env.MUSIC_BUCKET.delete(inst.storage_uri.substring("r2://".length));
          } else if (inst.storage_uri.startsWith("webdav://")) {
            const rest = inst.storage_uri.substring("webdav://".length);
            const slash = rest.indexOf("/");
            const path = slash >= 0 ? rest.substring(slash + 1) : "";
            const creds = await getSourceCredentials(env.DB, "webdav", env);
            if (creds) {
              const encodedPath = path.split("/").map(encodeURIComponent).join("/");
              const fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${encodedPath}`;
              await fetch(fullUrl, {
                method: "DELETE",
                headers: { Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}` },
              });
            }
          }
        } catch (e) {
          // Storage-side failure is logged but doesn't block the D1 cleanup
          // below — a file that's already gone (the common orphan case)
          // would otherwise permanently block deleting the dead DB rows.
          console.error(`[orphanSongs/delete] storage delete failed for ${inst.storage_uri}:`, e);
        }
      }

      await env.DB.batch([
        env.DB.prepare("DELETE FROM song_instances WHERE master_id = ?").bind(masterId),
        env.DB.prepare("DELETE FROM song_masters WHERE id = ?").bind(masterId),
        // Drop any album left with no masters so it stops showing up as a
        // clickable-but-empty card in the library (the "光年之外" ghost case).
        env.DB.prepare(
          "DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = albums.id)",
        ),
      ]);
      items.push({ masterId, ok: true });
    } catch (e) {
      items.push({ masterId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const deleted = items.filter((i) => i.ok).length;
  return c.json({ ok: true, deleted, failed: items.length - deleted, items });
});

// ============================================================================
// POST /edgesonic/maintenance/repairBitrates
// ============================================================================
// Recomputes stored bitrates from file size and duration. The browser pool
// parses head+tail slices, so parser-reported rates describe the slice rather
// than the track and land an order of magnitude low on lossless formats.
// Nothing is downloaded: size and duration are already on the row.
// `dryRun` reports what would change without writing.
maintenanceRoutes.post("/maintenance/repairBitrates",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ dryRun?: boolean }>().catch(() => ({} as { dryRun?: boolean }));
  const dryRun = body.dryRun === true;

  const rows = (await env.DB.prepare(
    `SELECT id, suffix, size, duration, bit_rate FROM song_instances
     WHERE missing = 0 AND size > 0 AND duration > 0`,
  ).all<{ id: string; suffix: string | null; size: number; duration: number; bit_rate: number | null }>()).results ?? [];

  const stale: Array<{ id: string; suffix: string | null; from: number | null; to: number }> = [];
  for (const r of rows) {
    const measured = deriveBitrate(r.size, r.duration);
    if (measured === null || !bitrateNeedsRepair(r.bit_rate, measured)) continue;
    stale.push({ id: r.id, suffix: r.suffix, from: r.bit_rate, to: measured });
  }

  if (!dryRun && stale.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    // Chunked so a large library stays inside D1's statement limits.
    for (let i = 0; i < stale.length; i += 50) {
      await env.DB.batch(stale.slice(i, i + 50).map((s) =>
        env.DB.prepare("UPDATE song_instances SET bit_rate = ?, updated_at = ? WHERE id = ?")
          .bind(s.to, now, s.id)));
    }
  }

  const byFormat: Record<string, number> = {};
  for (const s of stale) byFormat[s.suffix || "?"] = (byFormat[s.suffix || "?"] ?? 0) + 1;

  return c.json({
    ok: true,
    dryRun,
    examined: rows.length,
    repaired: dryRun ? 0 : stale.length,
    wouldRepair: stale.length,
    byFormat,
    samples: stale.slice(0, 10),
  });
});

// ============================================================================
// POST /edgesonic/maintenance/repairCoverTypes
// ============================================================================
// Rewrites cover media types that disagree with the artwork's own bytes. Tags
// declare types loosely ("PNG", "-->", or simply the wrong one), and a client
// that trusts the header then cannot decode an otherwise valid image. Reads
// only the first bytes of each object unless a rewrite is actually needed.
maintenanceRoutes.post("/maintenance/repairCoverTypes",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ dryRun?: boolean; limit?: number }>().catch(() => ({} as { dryRun?: boolean; limit?: number }));
  const dryRun = body.dryRun === true;
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 2000) : 2000;

  const keys = [
    ...((await env.DB.prepare(
      "SELECT cover_r2_key AS k FROM albums WHERE cover_r2_key IS NOT NULL",
    ).all<{ k: string }>()).results ?? []),
    ...((await env.DB.prepare(
      "SELECT image_r2_key AS k FROM artists WHERE image_r2_key IS NOT NULL",
    ).all<{ k: string }>()).results ?? []),
  ].map((r) => r.k).slice(0, limit);

  const fixed: Array<{ key: string; from: string | null; to: string }> = [];
  let missing = 0;
  for (const key of keys) {
    const head = await env.MUSIC_BUCKET.get(key, { range: { offset: 0, length: 16 } });
    if (!head) { missing++; continue; }
    const magic = new Uint8Array(await head.arrayBuffer());
    const sniffed = sniffImageMime(magic);
    if (!sniffed) continue;                       // unknown format: leave as-is
    const stored = head.httpMetadata?.contentType ?? null;
    if (stored === sniffed) continue;
    fixed.push({ key, from: stored, to: sniffed });
    if (dryRun) continue;
    const full = await env.MUSIC_BUCKET.get(key);
    if (!full) { missing++; continue; }
    await env.MUSIC_BUCKET.put(key, await full.arrayBuffer(), {
      httpMetadata: { contentType: sniffed },
    });
  }

  return c.json({
    ok: true,
    dryRun,
    examined: keys.length,
    missing,
    repaired: dryRun ? 0 : fixed.length,
    wouldRepair: fixed.length,
    samples: fixed.slice(0, 10),
  });
});

// ============================================================================
// POST /edgesonic/maintenance/backfillCovers
// ============================================================================
// Registers covers for albums that never got one. Unlike the repair above this
// has to read from storage: the artwork is embedded in the audio files, so each
// album costs a couple of ranged reads. Bounded per call and resumable — run it
// until `remaining` reaches zero. Albums whose files carry no artwork are
// reported as `noArt` and will be retried on a later run.
maintenanceRoutes.post("/maintenance/backfillCovers",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ limit?: number; dryRun?: boolean }>().catch(() => ({} as { limit?: number; dryRun?: boolean }));
  const dryRun = body.dryRun === true;
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 100) : 25;

  const pending = (await env.DB.prepare(
    `SELECT a.id FROM albums a
     WHERE a.cover_r2_key IS NULL
       AND EXISTS (SELECT 1 FROM song_masters sm
                   JOIN song_instances si ON si.master_id = sm.id AND si.missing = 0
                   WHERE sm.album_id = a.id)
     ORDER BY a.id`,
  ).all<{ id: string }>()).results ?? [];

  const batch = pending.slice(0, limit);
  const resolved: string[] = [];
  const noArt: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  if (!dryRun) {
    const { resolveAlbumCover } = await import("../../utils/covers");
    for (const album of batch) {
      try {
        const key = await resolveAlbumCover(env, album.id);
        if (key) resolved.push(album.id);
        else noArt.push(album.id);
      } catch (e) {
        failed.push({ id: album.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return c.json({
    ok: true,
    dryRun,
    pending: pending.length,
    attempted: dryRun ? 0 : batch.length,
    resolved: resolved.length,
    noArt: noArt.length,
    failed: failed.length,
    remaining: pending.length - resolved.length,
    failures: failed.slice(0, 5),
  });
});

// ============================================================================
// POST /edgesonic/maintenance/normalizeCoverKeys
// ============================================================================
// Two write paths once disagreed on how a cover key is built, leaving both
// covers/al-<id> and covers/al-al-<id> in storage. This rewrites the stray
// ones onto the canonical covers/<albumId>, moving the object, re-pointing
// every row that referenced it, and dropping the thumbnails derived from the
// old key so they regenerate under the new one.
//
// Bounded per call — each album costs a list, a read, a write and a few
// deletes — and resumable: run until `remaining` is zero.
maintenanceRoutes.post("/maintenance/normalizeCoverKeys",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ limit?: number; dryRun?: boolean }>().catch(() => ({} as { limit?: number; dryRun?: boolean }));
  const dryRun = body.dryRun === true;
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 50) : 10;

  const rows = (await env.DB.prepare(
    "SELECT id, cover_r2_key FROM albums WHERE cover_r2_key IS NOT NULL",
  ).all<{ id: string; cover_r2_key: string }>()).results ?? [];
  const stray = rows.filter((r) => r.cover_r2_key !== `covers/${r.id}`);

  const moved: Array<{ from: string; to: string; thumbs: number }> = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const row of stray.slice(0, dryRun ? stray.length : limit)) {
    const target = `covers/${row.id}`;
    if (dryRun) { moved.push({ from: row.cover_r2_key, to: target, thumbs: 0 }); continue; }
    try {
      const source = await env.MUSIC_BUCKET.get(row.cover_r2_key);
      if (source) {
        const bytes = new Uint8Array(await source.arrayBuffer());
        await env.MUSIC_BUCKET.put(target, bytes, {
          httpMetadata: { contentType: resolveImageMime(source.httpMetadata?.contentType, bytes) },
        });
      }
      // Everything derived from the old key: the object itself plus its
      // <key>_s<size>.<ext> thumbnails.
      const derived = await env.MUSIC_BUCKET.list({ prefix: row.cover_r2_key });
      let thumbs = 0;
      for (const obj of derived.objects) {
        await env.MUSIC_BUCKET.delete(obj.key);
        if (obj.key !== row.cover_r2_key) thumbs++;
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE albums SET cover_r2_key = ?, updated_at = ? WHERE id = ?")
          .bind(target, Math.floor(Date.now() / 1000), row.id),
        // Tracks that reused the album's object point at the old key too.
        env.DB.prepare("UPDATE song_masters SET cover_r2_key = ? WHERE cover_r2_key = ?")
          .bind(target, row.cover_r2_key),
      ]);
      moved.push({ from: row.cover_r2_key, to: target, thumbs });
    } catch (e) {
      failed.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({
    ok: true,
    dryRun,
    total: rows.length,
    stray: stray.length,
    moved: dryRun ? 0 : moved.length,
    failed: failed.length,
    remaining: stray.length - (dryRun ? 0 : moved.length),
    samples: moved.slice(0, 5),
    failures: failed.slice(0, 5),
  });
});
