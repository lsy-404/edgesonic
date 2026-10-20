// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Catalog merge primitives shared by the historical storage-URI dedupe and
// the library diagnostics tool. A merge keeps one song master (or album) and
// moves everything that points at the duplicates onto it: user annotations,
// bookmarks, playlists, shares, play queues, clone identity rows and the
// physical instances themselves. Nothing here touches storage except
// retireInstance, which callers invoke explicitly after a merge.

import { getSourceCredentials } from "../adapters/index";
import { r2KeyFromUri } from "./storageResolver";

export interface MergeableMaster {
  id: string;
  title: string | null;
  artist_id: string | null;
  album_id: string | null;
  album_artist_id: string | null;
  cover_r2_key: string | null;
  sort_title: string | null;
  track: number | null;
  disc: number | null;
  duration: number | null;
  genre: string | null;
  participants: string | null;
  lyrics: string | null;
  lyrics_rich: string | null;
  created_at: number | null;
}

export const MERGEABLE_MASTER_COLUMNS =
  `sm.id, sm.title, sm.artist_id, sm.album_id, sm.album_artist_id,
   sm.cover_r2_key, sm.sort_title, sm.track, sm.disc, sm.duration,
   sm.genre, sm.participants, sm.lyrics, sm.lyrics_rich, sm.created_at`;

function present(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

export function masterMetadataScore(master: MergeableMaster): number {
  let score = 0;
  if (present(master.title)) score++;
  if (present(master.artist_id) && master.artist_id !== "unknown-artist") score++;
  if (present(master.album_id) && master.album_id !== "pending-uploads") score++;
  if (present(master.album_artist_id)) score++;
  if (present(master.cover_r2_key)) score++;
  if (present(master.sort_title)) score++;
  if (master.track !== null) score++;
  if (master.disc !== null) score++;
  if (master.duration !== null && master.duration > 0) score++;
  if (present(master.genre)) score++;
  if (present(master.participants)) score++;
  if (present(master.lyrics)) score += 2;
  if (present(master.lyrics_rich)) score += 2;
  return score;
}

export function chooseSurvivorMaster<T extends MergeableMaster>(masters: T[]): T {
  return [...masters].sort((a, b) => {
    const scoreDiff = masterMetadataScore(b) - masterMetadataScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    const createdDiff = (a.created_at ?? Number.MAX_SAFE_INTEGER) - (b.created_at ?? Number.MAX_SAFE_INTEGER);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  })[0];
}

interface QueueRow { user_id: string; song_ids: string; current_id: string | null }

export async function rewritePlayQueues(db: D1Database, duplicateMasterIds: string[], survivorMasterId: string, now: number) {
  const queues = (await db.prepare("SELECT user_id, song_ids, current_id FROM play_queues").all<QueueRow>()).results;
  const duplicates = new Set(duplicateMasterIds);
  const writes: D1PreparedStatement[] = [];
  for (const queue of queues) {
    let ids: unknown;
    try { ids = JSON.parse(queue.song_ids); } catch { continue; }
    if (!Array.isArray(ids) || !ids.some((id) => typeof id === "string" && duplicates.has(id))) continue;
    const nextIds = ids.map((id) => typeof id === "string" && duplicates.has(id) ? survivorMasterId : id);
    const nextCurrent = queue.current_id && duplicates.has(queue.current_id) ? survivorMasterId : queue.current_id;
    writes.push(db.prepare(
      "UPDATE play_queues SET song_ids = ?, current_id = ?, updated_at = ? WHERE user_id = ?",
    ).bind(JSON.stringify(nextIds), nextCurrent, now, queue.user_id));
  }
  if (writes.length > 0) await db.batch(writes);
}

// Fills the survivor's empty fields from the duplicate and moves every
// reference (including the duplicate's instances) onto the survivor. The
// duplicate master row itself is left for the caller to delete once any
// instance-level cleanup has been queued after these statements.
export function masterMergeStatements(
  db: D1Database,
  survivorId: string,
  duplicate: MergeableMaster,
  now: number,
): D1PreparedStatement[] {
  return [
    db.prepare(
      `UPDATE song_masters SET
         title = COALESCE(NULLIF(title, ''), NULLIF(?, '')),
         artist_id = COALESCE(NULLIF(artist_id, ''), NULLIF(?, '')),
         album_id = COALESCE(NULLIF(album_id, ''), NULLIF(?, '')),
         album_artist_id = COALESCE(NULLIF(album_artist_id, ''), NULLIF(?, '')),
         cover_r2_key = COALESCE(NULLIF(cover_r2_key, ''), NULLIF(?, '')),
         sort_title = COALESCE(NULLIF(sort_title, ''), NULLIF(?, '')),
         track = COALESCE(track, ?),
         disc = COALESCE(disc, ?),
         duration = COALESCE(duration, ?),
         genre = COALESCE(NULLIF(genre, ''), NULLIF(?, '')),
         participants = COALESCE(NULLIF(participants, ''), NULLIF(?, '')),
         lyrics = COALESCE(NULLIF(lyrics, ''), NULLIF(?, '')),
         lyrics_rich = COALESCE(NULLIF(lyrics_rich, ''), NULLIF(?, ''))
       WHERE id = ?`,
    ).bind(
      duplicate.title,
      duplicate.artist_id,
      duplicate.album_id,
      duplicate.album_artist_id,
      duplicate.cover_r2_key,
      duplicate.sort_title,
      duplicate.track,
      duplicate.disc,
      duplicate.duration,
      duplicate.genre,
      duplicate.participants,
      duplicate.lyrics,
      duplicate.lyrics_rich,
      survivorId,
    ),
    db.prepare("INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT ?, artist_id, position FROM song_artists WHERE song_id = ?").bind(survivorId, duplicate.id),
    db.prepare("DELETE FROM song_artists WHERE song_id = ?").bind(duplicate.id),
    annotationMergeStatement(db, "song", survivorId, duplicate.id),
    db.prepare("DELETE FROM annotations WHERE item_id = ? AND item_type = 'song'").bind(duplicate.id),
    db.prepare(
      `INSERT INTO bookmarks (user_id, song_master_id, position_ms, comment, created_at, updated_at)
       SELECT user_id, ?, position_ms, comment, created_at, updated_at FROM bookmarks WHERE song_master_id = ?
       ON CONFLICT(user_id, song_master_id) DO UPDATE SET
         position_ms = CASE WHEN excluded.updated_at > bookmarks.updated_at THEN excluded.position_ms ELSE bookmarks.position_ms END,
         comment = CASE WHEN excluded.updated_at > bookmarks.updated_at THEN excluded.comment ELSE bookmarks.comment END,
         created_at = MIN(bookmarks.created_at, excluded.created_at),
         updated_at = MAX(bookmarks.updated_at, excluded.updated_at)`,
    ).bind(survivorId, duplicate.id),
    db.prepare("DELETE FROM bookmarks WHERE song_master_id = ?").bind(duplicate.id),
    db.prepare("UPDATE playlist_songs SET song_master_id = ? WHERE song_master_id = ?").bind(survivorId, duplicate.id),
    db.prepare("UPDATE share_entries SET song_master_id = ? WHERE song_master_id = ?").bind(survivorId, duplicate.id),
    db.prepare("UPDATE now_playing SET song_id = ? WHERE song_id = ?").bind(survivorId, duplicate.id),
    db.prepare("UPDATE scrape_jobs SET song_master_id = ? WHERE song_master_id = ?").bind(survivorId, duplicate.id),
    db.prepare("UPDATE clone_id_map SET local_id = ?, updated_at = ? WHERE item_type = 'song' AND local_id = ?").bind(survivorId, now, duplicate.id),
    db.prepare("UPDATE song_instances SET master_id = ?, updated_at = ? WHERE master_id = ?").bind(survivorId, now, duplicate.id),
  ];
}

function annotationMergeStatement(db: D1Database, itemType: "song" | "album", survivorId: string, duplicateId: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO annotations (user_id, item_id, item_type, play_count, play_date, rating, starred, starred_at)
     SELECT user_id, ?, item_type, play_count, play_date, rating, starred, starred_at
     FROM annotations WHERE item_id = ? AND item_type = ?
     ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
       play_count = annotations.play_count + excluded.play_count,
       play_date = MAX(annotations.play_date, excluded.play_date),
       rating = COALESCE(annotations.rating, excluded.rating),
       starred = MAX(annotations.starred, excluded.starred),
       starred_at = CASE
         WHEN annotations.starred_at IS NULL THEN excluded.starred_at
         WHEN excluded.starred_at IS NULL THEN annotations.starred_at
         ELSE MIN(annotations.starred_at, excluded.starred_at)
       END`,
  ).bind(survivorId, duplicateId, itemType);
}

async function loadMasters(db: D1Database, ids: string[]): Promise<Map<string, MergeableMaster>> {
  const found = new Map<string, MergeableMaster>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const rows = (await db.prepare(
      `SELECT ${MERGEABLE_MASTER_COLUMNS} FROM song_masters sm WHERE sm.id IN (${chunk.map(() => "?").join(", ")})`,
    ).bind(...chunk).all<MergeableMaster>()).results;
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

export interface SongMergeResult {
  survivorId: string;
  mergedIds: string[];
  touchedAlbumIds: string[];
}

// Merges distinct-file duplicates into one master. Instances keep their files;
// they become alternate qualities of the survivor until retireInstance runs.
export async function mergeSongMasters(
  db: D1Database,
  survivorId: string,
  duplicateIds: string[],
  now = Math.floor(Date.now() / 1000),
): Promise<SongMergeResult> {
  const ids = [...new Set(duplicateIds.filter((id) => id && id !== survivorId))];
  const masters = await loadMasters(db, [survivorId, ...ids]);
  const survivor = masters.get(survivorId);
  if (!survivor) throw new Error("Survivor song no longer exists");
  const duplicates = ids.map((id) => masters.get(id)).filter((row): row is MergeableMaster => !!row);
  if (duplicates.length === 0) return { survivorId, mergedIds: [], touchedAlbumIds: [] };

  await rewritePlayQueues(db, duplicates.map((row) => row.id), survivorId, now);
  const statements = duplicates.flatMap((duplicate) => masterMergeStatements(db, survivorId, duplicate, now));
  for (const duplicate of duplicates) {
    statements.push(db.prepare("DELETE FROM song_masters WHERE id = ?").bind(duplicate.id));
  }
  await db.batch(statements);

  const touchedAlbumIds = [...new Set([survivor.album_id, ...duplicates.map((row) => row.album_id)]
    .filter((id): id is string => !!id))];
  await refreshAlbumAggregates(db, touchedAlbumIds, now);
  return { survivorId, mergedIds: duplicates.map((row) => row.id), touchedAlbumIds };
}

// Recomputes cached album totals and drops albums left without songs. An
// emptied album leaves its display group first: deleting a grouped album
// fires a trigger that dissolves the whole group, which would also ungroup
// the albums that are still there.
export async function refreshAlbumAggregates(db: D1Database, albumIds: string[], now = Math.floor(Date.now() / 1000)) {
  const statements: D1PreparedStatement[] = [];
  for (const albumId of new Set(albumIds)) {
    statements.push(
      db.prepare(
        `UPDATE albums SET
           song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = ?),
           duration = (SELECT COALESCE(SUM(duration), 0) FROM song_masters WHERE album_id = ?),
           size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si
                   JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = ?),
           updated_at = ?
         WHERE id = ?`,
      ).bind(albumId, albumId, albumId, now, albumId),
      ...emptyAlbumCleanupStatements(db, albumId),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

export function emptyAlbumCleanupStatements(db: D1Database, albumId: string): D1PreparedStatement[] {
  const empty = "NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = ?)";
  return [
    db.prepare(
      `DELETE FROM album_display_groups
       WHERE id IN (SELECT group_id FROM album_display_group_members WHERE album_id = ?)
         AND ${empty}
         AND (SELECT COUNT(*) FROM album_display_group_members m
              WHERE m.group_id = album_display_groups.id) <= 2`,
    ).bind(albumId, albumId),
    db.prepare(
      `DELETE FROM album_display_group_members
       WHERE NOT EXISTS (SELECT 1 FROM album_display_groups g WHERE g.id = album_display_group_members.group_id)`,
    ),
    db.prepare(`DELETE FROM album_display_group_members WHERE album_id = ? AND ${empty}`).bind(albumId, albumId),
    db.prepare(`DELETE FROM albums WHERE id = ? AND ${empty}`).bind(albumId, albumId),
  ];
}

interface AlbumRow {
  id: string;
  year: number | null;
  genre: string | null;
  cover_r2_key: string | null;
  compilation: number | null;
}

// Moves every song of the duplicate albums into the survivor album. Matching
// songs inside the merged album are not combined here; callers pair them and
// run mergeSongMasters so file handling stays an explicit second decision.
export async function mergeAlbums(
  db: D1Database,
  survivorId: string,
  duplicateIds: string[],
  now = Math.floor(Date.now() / 1000),
): Promise<{ survivorId: string; mergedIds: string[] }> {
  const ids = [...new Set(duplicateIds.filter((id) => id && id !== survivorId))];
  const all = [survivorId, ...ids];
  const rows = (await db.prepare(
    `SELECT id, year, genre, cover_r2_key, compilation FROM albums WHERE id IN (${all.map(() => "?").join(", ")})`,
  ).bind(...all).all<AlbumRow>()).results;
  if (!rows.some((row) => row.id === survivorId)) throw new Error("Survivor album no longer exists");
  const duplicates = rows.filter((row) => row.id !== survivorId);
  if (duplicates.length === 0) return { survivorId, mergedIds: [] };

  const statements: D1PreparedStatement[] = [];
  for (const duplicate of duplicates) {
    statements.push(
      db.prepare(
        `UPDATE albums SET
           year = COALESCE(year, ?),
           genre = COALESCE(NULLIF(genre, ''), NULLIF(?, '')),
           cover_r2_key = COALESCE(NULLIF(cover_r2_key, ''), NULLIF(?, '')),
           compilation = MAX(COALESCE(compilation, 0), COALESCE(?, 0)),
           updated_at = ?
         WHERE id = ?`,
      ).bind(duplicate.year, duplicate.genre, duplicate.cover_r2_key, duplicate.compilation, now, survivorId),
      db.prepare("UPDATE song_masters SET album_id = ?, updated_at = ? WHERE album_id = ?").bind(survivorId, now, duplicate.id),
      annotationMergeStatement(db, "album", survivorId, duplicate.id),
      db.prepare("DELETE FROM annotations WHERE item_id = ? AND item_type = 'album'").bind(duplicate.id),
      db.prepare("UPDATE clone_id_map SET local_id = ?, updated_at = ? WHERE item_type = 'album' AND local_id = ?").bind(survivorId, now, duplicate.id),
      // The survivor inherits the duplicate's display group when it has none.
      db.prepare(
        `UPDATE album_display_group_members SET album_id = ?
         WHERE album_id = ? AND NOT EXISTS (SELECT 1 FROM album_display_group_members WHERE album_id = ?)`,
      ).bind(survivorId, duplicate.id, survivorId),
      ...emptyAlbumCleanupStatements(db, duplicate.id),
    );
  }
  await db.batch(statements);
  await refreshAlbumAggregates(db, [survivorId], now);
  return { survivorId, mergedIds: duplicates.map((row) => row.id) };
}

export interface RetirableInstance {
  id: string;
  master_id: string;
  source_id: string;
  storage_uri: string;
  storage_object_id: string | null;
}

export interface RetireResult {
  instanceId: string;
  ok: boolean;
  storageDeleted: boolean;
  error?: string;
}

// Removes one physical copy: its derived transcodes/caches first, then the
// stored bytes when no other entry or instance still references them, then
// the catalog rows. Storage goes first so a failed delete leaves the catalog
// pointing at a file that still exists.
export async function retireInstance(env: Env, instanceId: string): Promise<RetireResult[]> {
  const db = env.DB;
  const instance = await db.prepare(
    "SELECT id, master_id, source_id, storage_uri, storage_object_id FROM song_instances WHERE id = ?",
  ).bind(instanceId).first<RetirableInstance>();
  if (!instance) return [{ instanceId, ok: true, storageDeleted: false }];

  const results: RetireResult[] = [];
  const children = (await db.prepare("SELECT id FROM song_instances WHERE parent_instance_id = ? AND id != ?")
    .bind(instanceId, instanceId).all<{ id: string }>()).results;
  for (const child of children) results.push(...await retireInstance(env, child.id));
  if (results.some((result) => !result.ok)) {
    return [...results, { instanceId, ok: false, storageDeleted: false, error: "Derived copy could not be removed" }];
  }

  let storageDeleted = false;
  let deleteObjectId: string | null = null;
  try {
    const target = await storageTarget(db, instance);
    if (target?.kind === "r2") {
      await env.MUSIC_BUCKET.delete(target.key);
      storageDeleted = true;
      deleteObjectId = target.objectId;
    } else if (target?.kind === "webdav") {
      const creds = await getSourceCredentials(db, "webdav", env);
      if (!creds) throw new Error("WebDAV source is not configured");
      const encodedPath = target.path.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`${creds.baseUrl.replace(/\/$/, "")}/${encodedPath}`, {
        method: "DELETE",
        headers: { Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}` },
      });
      if (!response.ok && response.status !== 404) throw new Error(`WebDAV delete failed: HTTP ${response.status}`);
      storageDeleted = true;
    }
  } catch (error) {
    return [...results, {
      instanceId,
      ok: false,
      storageDeleted: false,
      error: `Storage deletion failed; catalog records were retained (${error instanceof Error ? error.message : String(error)})`,
    }];
  }

  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM transcode_jobs WHERE instance_id = ?").bind(instanceId),
    db.prepare("UPDATE transcode_jobs SET output_instance_id = NULL WHERE output_instance_id = ?").bind(instanceId),
    db.prepare(
      `UPDATE work_queue
       SET status = 'canceled', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
           error_message = 'canceled: duplicate instance retired'
       WHERE task_type = 'metadata' AND status IN ('queued', 'claimed')
         AND json_extract(payload, '$.instanceId') = ?`,
    ).bind(instanceId),
    db.prepare("DELETE FROM storage_entries WHERE instance_id = ? AND kind = 'file'").bind(instanceId),
    db.prepare("DELETE FROM song_instances WHERE id = ?").bind(instanceId),
  ];
  if (deleteObjectId) {
    statements.push(db.prepare(
      `DELETE FROM storage_objects WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM storage_entries WHERE object_id = ?)
         AND NOT EXISTS (SELECT 1 FROM song_instances WHERE storage_object_id = ?)`,
    ).bind(deleteObjectId, deleteObjectId, deleteObjectId));
  }
  await db.batch(statements);
  return [...results, { instanceId, ok: true, storageDeleted }];
}

type StorageTarget =
  | { kind: "r2"; key: string; objectId: string | null }
  | { kind: "webdav"; path: string };

// Resolves the bytes behind an instance only when this instance is their last
// reference; shared objects and external mounts yield null (catalog-only).
async function storageTarget(db: D1Database, instance: RetirableInstance): Promise<StorageTarget | null> {
  if (instance.storage_object_id) {
    const object = await db.prepare(
      `SELECT physical_key,
              (SELECT COUNT(*) FROM storage_entries WHERE object_id = ?1 AND (instance_id IS NULL OR instance_id != ?2)) AS entry_refs,
              (SELECT COUNT(*) FROM song_instances WHERE storage_object_id = ?1 AND id != ?2) AS instance_refs
       FROM storage_objects WHERE id = ?1`,
    ).bind(instance.storage_object_id, instance.id).first<{ physical_key: string; entry_refs: number; instance_refs: number }>();
    if (!object) return null;
    if (object.entry_refs > 0 || object.instance_refs > 0) return null;
    return { kind: "r2", key: object.physical_key, objectId: instance.storage_object_id };
  }

  const others = await db.prepare("SELECT COUNT(*) AS n FROM song_instances WHERE storage_uri = ? AND id != ?")
    .bind(instance.storage_uri, instance.id).first<{ n: number }>();
  if (others?.n) return null;
  if (instance.storage_uri.startsWith("r2://")) {
    const key = r2KeyFromUri(instance.storage_uri);
    const object = await db.prepare(
      "SELECT id FROM storage_objects WHERE physical_key = ? OR legacy_key = ? LIMIT 1",
    ).bind(key, key).first<{ id: string }>();
    if (object) return null;
    return { kind: "r2", key, objectId: null };
  }
  if (instance.storage_uri.startsWith("webdav://")) {
    const rest = instance.storage_uri.slice("webdav://".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? { kind: "webdav", path: rest.slice(slash + 1) } : null;
  }
  return null;
}
