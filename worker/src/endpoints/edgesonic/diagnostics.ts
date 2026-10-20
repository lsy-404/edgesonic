// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Library diagnostics: a read-only scan plus the fixes it proposes. Every fix
// endpoint re-plans from current rows (a scoped snapshot) and refuses when the
// catalog no longer matches what was shown, so a stale page cannot merge or
// delete the wrong thing. File removal additionally needs the `delete`
// permission and always removes storage before catalog rows.

import { Hono } from "hono";
import type { User } from "../../types/entities";
import { permissionMiddleware } from "../../auth";
import { hasPermission } from "../../utils/permissions";
import { dispatchWorkBatch } from "./work";
import { fingerprintR2Object, parseFingerprint } from "../../utils/audioFingerprint";
import {
  emptyAlbumCleanupStatements,
  mergeAlbums,
  mergeSongMasters,
  refreshAlbumAggregates,
  retireInstance,
  type RetireResult,
} from "../../utils/catalogMerge";
import { compilationMarkerStatement } from "../../utils/albumIdentity";
import { artistInsertStatements, deleteUnusedArtists, parseAlbumArtistCredit } from "../../utils/artistCredits";
import { r2KeyFromUri } from "../../utils/storageResolver";
import {
  buildDiagnosticsReport,
  dataSegmentMatch,
  defaultFileMode,
  findFolderAlbumIssues,
  loadCatalogSnapshot,
  pairAlbumSongs,
  planAlbumIssues,
  planRetirement,
  planSongIssues,
  type CatalogSnapshot,
  type DataIssueKind,
  type FileMode,
  type SongRow,
} from "../../utils/libraryDiagnostics";

export const diagnosticsRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const guard = permissionMiddleware("maintenance_cleanup");

const MERGE_MAX_SONGS = 20;
const MERGE_MAX_ALBUMS = 10;
const FOLDER_MAX_SONGS = 300;
const ERROR_FIX_MAX = 100;
const FINGERPRINT_MAX_INSTANCES = 12;
const FINGERPRINT_MAX_BYTES = 768 * 1024 * 1024;

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].slice(0, max);
}

function fileMode(value: unknown): FileMode | null {
  return value === "exact" || value === "best" ? value : null;
}

function canDeleteFiles(env: Env, user: User): Promise<boolean> {
  return hasPermission(env, user, "delete");
}

function failure(error: string) {
  return { ok: false as const, error };
}

// Retires the planned copies of one song and refreshes its album totals.
async function retireFor(env: Env, songId: string, mode: FileMode): Promise<{ retired: RetireResult[]; failed: RetireResult[] }> {
  const snapshot = await loadCatalogSnapshot(env.DB, { songIds: [songId] });
  const song = snapshot.songsById.get(songId);
  if (!song) return { retired: [], failed: [] };
  const results: RetireResult[] = [];
  for (const instanceId of planRetirement(snapshot.instancesByMaster.get(songId) ?? [], mode)) {
    results.push(...await retireInstance(env, instanceId));
  }
  if (song.album_id) await refreshAlbumAggregates(env.DB, [song.album_id]);
  return { retired: results.filter((result) => result.ok), failed: results.filter((result) => !result.ok) };
}

// ---------------------------------------------------------------------------
// GET /edgesonic/diagnostics/scan
// ---------------------------------------------------------------------------
diagnosticsRoutes.get("/diagnostics/scan", guard, async (c) => {
  const report = buildDiagnosticsReport(await loadCatalogSnapshot(c.env.DB));
  return c.json({ ok: true, canDeleteFiles: await canDeleteFiles(c.env, c.get("user")), ...report });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/diagnostics/fingerprint  { instanceIds }
// ---------------------------------------------------------------------------
// Computes and caches data-segment fingerprints for R2 copies. Work is capped
// per request; ids past the budget come back in `remaining` for the next call.
diagnosticsRoutes.post("/diagnostics/fingerprint", guard, async (c) => {
  const ids = stringList((await readBody(c.req.raw)).instanceIds, 200);
  if (ids.length === 0) return c.json(failure("Missing instanceIds"), 400);

  const results: Array<{ id: string; fingerprint: string | null; error?: string }> = [];
  const remaining: string[] = [];
  let processed = 0;
  let bytes = 0;
  for (const id of ids) {
    if (processed >= FINGERPRINT_MAX_INSTANCES || bytes >= FINGERPRINT_MAX_BYTES) {
      remaining.push(id);
      continue;
    }
    const row = await c.env.DB.prepare(
      `SELECT si.storage_uri, si.suffix, si.size, so.physical_key, so.size AS object_size
       FROM song_instances si LEFT JOIN storage_objects so ON so.id = si.storage_object_id
       WHERE si.id = ?`,
    ).bind(id).first<{ storage_uri: string; suffix: string; size: number | null; physical_key: string | null; object_size: number | null }>();
    if (!row) {
      results.push({ id, fingerprint: null, error: "not found" });
      continue;
    }
    const key = row.physical_key ?? (row.storage_uri.startsWith("r2://") ? r2KeyFromUri(row.storage_uri) : null);
    if (!key) {
      results.push({ id, fingerprint: null, error: "unsupported source" });
      continue;
    }
    processed++;
    bytes += row.object_size ?? row.size ?? 0;
    try {
      const value = await fingerprintR2Object(c.env.MUSIC_BUCKET, key, row.suffix);
      if (value) {
        await c.env.DB.prepare("UPDATE song_instances SET source_dedup_key = ? WHERE id = ?").bind(value, id).run();
      }
      results.push({ id, fingerprint: parseFingerprint(value)?.identity ?? null });
    } catch (error) {
      results.push({ id, fingerprint: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return c.json({ ok: true, results, remaining });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/diagnostics/songs/merge  { survivorId, songIds, mode }
// ---------------------------------------------------------------------------
diagnosticsRoutes.post("/diagnostics/songs/merge", guard, async (c) => {
  const body = await readBody(c.req.raw);
  const survivorId = typeof body.survivorId === "string" ? body.survivorId : "";
  const songIds = stringList(body.songIds, MERGE_MAX_SONGS).filter((id) => id !== survivorId);
  const mode = fileMode(body.mode);
  if (!survivorId || songIds.length === 0 || !mode) return c.json(failure("Missing survivorId, songIds or mode"), 400);

  const snapshot = await loadCatalogSnapshot(c.env.DB, { songIds: [survivorId, ...songIds] });
  if (!snapshot.songsById.has(survivorId)) return c.json(failure("The song to keep no longer exists; rescan"), 409);
  if (songIds.some((id) => !snapshot.songsById.has(id))) return c.json(failure("Some songs no longer exist; rescan"), 409);
  const instances = [survivorId, ...songIds].flatMap((id) => snapshot.instancesByMaster.get(id) ?? []);
  if (planRetirement(instances, mode).length > 0 && !await canDeleteFiles(c.env, c.get("user"))) {
    return c.json(failure("Removing duplicate files requires the delete permission"), 403);
  }

  const merge = await mergeSongMasters(c.env.DB, survivorId, songIds);
  const { retired, failed } = await retireFor(c.env, survivorId, mode);
  return c.json({ ok: failed.length === 0, merged: merge.mergedIds, retired, failed });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/diagnostics/songs/retire  { songId, mode }
// ---------------------------------------------------------------------------
// The file step of an album merge: run once per merged song.
diagnosticsRoutes.post("/diagnostics/songs/retire", guard, async (c) => {
  const body = await readBody(c.req.raw);
  const songId = typeof body.songId === "string" ? body.songId : "";
  const mode = fileMode(body.mode);
  if (!songId || !mode) return c.json(failure("Missing songId or mode"), 400);
  if (!await canDeleteFiles(c.env, c.get("user"))) return c.json(failure("Removing duplicate files requires the delete permission"), 403);
  const { retired, failed } = await retireFor(c.env, songId, mode);
  return c.json({ ok: failed.length === 0, retired, failed });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/diagnostics/albums/merge  { survivorId, albumIds, mode }
// ---------------------------------------------------------------------------
// Moves the duplicate albums' songs into the survivor and merges each paired
// song. `mode` is "auto" (best when the pair's data segments match, exact
// otherwise), "exact" or "best". The response lists the merged songs with
// their resolved file mode; the client then calls songs/retire for each so
// no single request has to delete a whole album of files.
diagnosticsRoutes.post("/diagnostics/albums/merge", guard, async (c) => {
  const body = await readBody(c.req.raw);
  const survivorId = typeof body.survivorId === "string" ? body.survivorId : "";
  const albumIds = stringList(body.albumIds, MERGE_MAX_ALBUMS).filter((id) => id !== survivorId);
  const requested = body.mode === "auto" ? "auto" : fileMode(body.mode);
  if (!survivorId || albumIds.length === 0 || !requested) return c.json(failure("Missing survivorId, albumIds or mode"), 400);

  const snapshot = await loadCatalogSnapshot(c.env.DB, { albumIds: [survivorId, ...albumIds] });
  if (!snapshot.albumsById.has(survivorId)) return c.json(failure("The album to keep no longer exists; rescan"), 409);
  if (albumIds.some((id) => !snapshot.albumsById.has(id))) return c.json(failure("Some albums no longer exist; rescan"), 409);

  const songsOf = (albumId: string) => snapshot.songs.filter((song) => song.album_id === albumId);
  const pool: SongRow[] = songsOf(survivorId);
  const pairs: Array<{ keep: SongRow; merge: SongRow; mode: FileMode; retire: number }> = [];
  for (const albumId of albumIds) {
    const result = pairAlbumSongs(pool, songsOf(albumId));
    for (const [keep, merge] of result.pairs) {
      const instances = [keep, merge].flatMap((song) => snapshot.instancesByMaster.get(song.id) ?? []);
      const mode = requested === "auto" ? defaultFileMode(dataSegmentMatch(instances)) : requested;
      pairs.push({ keep, merge, mode, retire: planRetirement(instances, mode).length });
    }
    pool.push(...result.unmatched);
  }
  if (pairs.some((pair) => pair.retire > 0) && !await canDeleteFiles(c.env, c.get("user"))) {
    return c.json(failure("Removing duplicate files requires the delete permission"), 403);
  }

  await mergeAlbums(c.env.DB, survivorId, albumIds);
  for (const pair of pairs) await mergeSongMasters(c.env.DB, pair.keep.id, [pair.merge.id]);
  await refreshAlbumAggregates(c.env.DB, [survivorId]);
  return c.json({
    ok: true,
    survivorId,
    merged: albumIds,
    songs: pairs.map((pair) => ({ songId: pair.keep.id, title: pair.keep.title, mode: pair.mode, retire: pair.retire })),
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/diagnostics/folders/fix  { songIds }
// ---------------------------------------------------------------------------
// Re-plans the folder album from the listed songs and applies it: one album,
// one album artist, and the planned disc/track numbers. The song set must be
// exactly one folder album as the scan reported it.
diagnosticsRoutes.post("/diagnostics/folders/fix", guard, async (c) => {
  const songIds = stringList((await readBody(c.req.raw)).songIds, FOLDER_MAX_SONGS);
  if (songIds.length === 0) return c.json(failure("Missing songIds"), 400);

  const snapshot = await loadCatalogSnapshot(c.env.DB, { songIds });
  const issues = findFolderAlbumIssues(snapshot);
  const requested = new Set(songIds);
  const issue = issues.find((candidate) =>
    candidate.songs.length === requested.size && candidate.songs.every((song) => requested.has(song.id)));
  if (!issue) return c.json(failure("The folder no longer matches the scan; rescan"), 409);
  if (!issue.autoFixable) return c.json(failure("This folder needs manual review"), 409);

  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];
  const unifies = issue.problems.some((problem) => problem === "splitAlbum" || problem === "albumArtist" || problem === "missingAlbumArtist");
  if (unifies) {
    const credit = parseAlbumArtistCredit(issue.proposedAlbumArtist);
    if (!credit) return c.json(failure("No album artist could be chosen"), 409);
    statements.push(...artistInsertStatements(db, [credit], now));
    for (const song of issue.songs) {
      statements.push(db.prepare(
        "UPDATE song_masters SET album_artist_id = ?, album_id = ?, updated_at = ? WHERE id = ?",
      ).bind(credit.id, issue.targetAlbumId, now, song.id));
    }
    statements.push(compilationMarkerStatement(db, issue.targetAlbumId));
  }
  for (const change of issue.trackChanges) {
    statements.push(db.prepare("UPDATE song_masters SET disc = ?, track = ?, updated_at = ? WHERE id = ?")
      .bind(change.toDisc, change.toTrack, now, change.songId));
  }
  await db.batch(statements);
  await refreshAlbumAggregates(db, issue.albums.map((album) => album.id), now);
  if (unifies) {
    // Only the album artists these songs no longer use can have become unused.
    await deleteUnusedArtists(db, issue.songs.map((song) => snapshot.songsById.get(song.id)?.album_artist_id ?? ""));
  }
  return c.json({
    ok: true,
    albumId: issue.targetAlbumId,
    albumArtist: unifies ? issue.proposedAlbumArtist : null,
    tracksChanged: issue.trackChanges.length,
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/diagnostics/errors/fix  { kind, ids }
// ---------------------------------------------------------------------------
const SONG_KINDS = new Set<DataIssueKind>(["objectTitle", "garbledTitle", "unknownDuration", "implausibleDuration", "ghostSong"]);
const ALBUM_KINDS = new Set<DataIssueKind>(["objectAlbumName", "emptyAlbum", "staleAlbumTotals"]);

diagnosticsRoutes.post("/diagnostics/errors/fix", guard, async (c) => {
  const body = await readBody(c.req.raw);
  const kind = body.kind as DataIssueKind;
  const ids = stringList(body.ids, ERROR_FIX_MAX);
  if (!SONG_KINDS.has(kind) && !ALBUM_KINDS.has(kind)) return c.json(failure("This kind of issue cannot be fixed automatically"), 400);
  if (ids.length === 0) return c.json(failure("Missing ids"), 400);

  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const snapshot: CatalogSnapshot = await loadCatalogSnapshot(db, SONG_KINDS.has(kind) ? { songIds: ids } : { albumIds: ids });
  const items: Array<{ id: string; ok: boolean; action?: string; error?: string }> = [];
  const touchedAlbums = new Set<string>();
  const reparse: Array<{ id: string; storage_uri: string; suffix: string; size: number | null }> = [];

  for (const id of ids) {
    const issue = SONG_KINDS.has(kind)
      ? (snapshot.songsById.has(id) ? planSongIssues(snapshot, snapshot.songsById.get(id)!) : [])
          .find((candidate) => candidate.kind === kind)
      : (snapshot.albumsById.has(id)
          ? planAlbumIssues(snapshot, snapshot.albumsById.get(id)!, snapshot.songs.filter((song) => song.album_id === id))
          : [])
          .find((candidate) => candidate.kind === kind);
    if (!issue?.fix) {
      items.push({ id, ok: false, error: issue ? "No automatic fix" : "Already resolved" });
      continue;
    }
    const fix = issue.fix;
    const song = snapshot.songsById.get(id);
    if (song?.album_id) touchedAlbums.add(song.album_id);
    switch (fix.action) {
      case "setTitle":
        await db.prepare("UPDATE song_masters SET title = ?, sort_title = ?, updated_at = ? WHERE id = ?")
          .bind(fix.value, fix.value.toLowerCase(), now, id).run();
        break;
      case "setAlbumName":
        await db.prepare("UPDATE albums SET name = ?, sort_name = ?, updated_at = ? WHERE id = ?")
          .bind(fix.value, fix.value.toLowerCase(), now, id).run();
        break;
      case "setDuration":
        await db.prepare("UPDATE song_masters SET duration = ?, updated_at = ? WHERE id = ?").bind(fix.value, now, id).run();
        break;
      case "reparse":
        for (const instance of snapshot.instancesByMaster.get(id) ?? []) {
          if (fix.instanceIds.includes(instance.id)) reparse.push(instance);
        }
        break;
      case "deleteSong":
        await db.batch([
          db.prepare("DELETE FROM annotations WHERE item_id = ? AND item_type = 'song'").bind(id),
          db.prepare("DELETE FROM song_masters WHERE id = ? AND NOT EXISTS (SELECT 1 FROM song_instances WHERE master_id = ?)").bind(id, id),
        ]);
        break;
      case "deleteAlbum":
        await db.batch(emptyAlbumCleanupStatements(db, id));
        break;
      case "refreshAlbum":
        touchedAlbums.add(id);
        break;
    }
    items.push({ id, ok: true, action: fix.action });
  }

  if (reparse.length > 0) {
    // Upsert so an explicit request re-runs a parse that already finished.
    await dispatchWorkBatch(db, reparse.map((instance) => ({
      taskType: "metadata",
      payload: { instanceId: instance.id, sourceUri: instance.storage_uri, suffix: instance.suffix, size: instance.size },
      requiredCaps: ["music-metadata"],
      priority: 5,
      dedupKey: `diagnostics:${instance.id}`,
      upsert: true,
    })), c.env);
  }
  if (touchedAlbums.size > 0) await refreshAlbumAggregates(db, [...touchedAlbums], now);
  if (kind === "ghostSong") {
    await deleteUnusedArtists(db, ids.flatMap((id) => {
      const song = snapshot.songsById.get(id);
      return song ? [song.artist_id ?? "", song.album_artist_id ?? ""] : [];
    }));
  }
  return c.json({ ok: true, fixed: items.filter((item) => item.ok).length, items });
});
