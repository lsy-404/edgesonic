// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { getFeatureString } from "../../utils/features";
import { albumNameFromSourcePath, recoverMetadataFromStoragePath, sourceFolderLogicalPath } from "../../utils/storageMetadata";
import { artistInsertStatements, parseAlbumArtistCredit, parseArtistCredits, songArtistStatements } from "../../utils/artistCredits";
import { md5 } from "../../utils/md5";
import { normalizeMetadataIdentity, isKnownMetadataIdentity, isCredibleMetadataMatch } from "../../../../shared/metadataRetrievalMatch";
import { notifyCoordinator } from "../../coordinator/workCoordinator";
import type { User } from "../../types/entities";

export const metadataRetrievalRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

interface ApplyAnnotation { ok: boolean; reason?: string; masterId?: string }

export const RETRIEVAL_APPLY_PENDING = "retrieval_apply:pending";
const RETRIEVAL_APPLYING_PREFIX = "retrieval_apply:applying:";
const RETRIEVAL_APPLY_LEASE_SECONDS = 10 * 60;
const RETRIEVAL_SOURCES = new Set(["lrc", "netease", "qmusic", "kugou"]);
const RETRIEVAL_RETRY_BUDGET = 3;

interface RetrievalSnapshot {
  title: string; artist: string; album: string; albumArtist: string | null;
  year: number | null; lyrics: string | null; coverR2Key: string | null;
  masterUpdatedAt: number; albumFolder: string | null;
}

interface RetrievalRow {
  id: string; task_type: string; status: string; attempts: number; error_message: string | null;
}

function metadataMissing(value: unknown, field: "title" | "artist" | "album" | "albumArtist" | "year" | "lyrics" | "cover"): boolean {
  if (field === "year") return typeof value !== "number" || value <= 0;
  if (field === "cover") return typeof value !== "string" || !value.trim();
  if (typeof value !== "string" || !value.trim()) return true;
  if (field === "lyrics") return false;
  return !isKnownMetadataIdentity(value);
}

function matchesKnownSnapshot(
  candidate: { title?: unknown; artist?: unknown; album?: unknown },
  snapshot: { title?: unknown; artist?: unknown; album?: unknown },
): boolean {
  return (["title", "artist", "album"] as const).every((field) =>
    !isKnownMetadataIdentity(snapshot[field]) ||
      normalizeMetadataIdentity(snapshot[field]) === normalizeMetadataIdentity(candidate[field]));
}

function parseConfiguredRetrievalSources(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((source): source is string =>
      typeof source === "string" && RETRIEVAL_SOURCES.has(source)))];
  } catch { return []; }
}

async function getRetrievalSources(env: Env): Promise<string[]> {
  return parseConfiguredRetrievalSources(await getFeatureString(
    env, "scrape_enabled_sources", '["lrc","netease","qmusic","kugou"]',
  ));
}

async function restartRetrievalTask(
  db: D1Database,
  payload: Record<string, unknown>,
): Promise<"queued" | "active" | "pending" | "invalid"> {
  const masterId = payload.masterId;
  if (typeof masterId !== "string") return "invalid";
  const taskId = `wt-scrape-retrieve:${masterId}`;
  const existing = await db.prepare(
    "SELECT id, task_type, status, attempts, error_message FROM work_queue WHERE id = ?",
  ).bind(taskId).first<RetrievalRow>();
  if (existing?.task_type === "scrape" && existing.status === "completed" &&
      (existing.error_message === RETRIEVAL_APPLY_PENDING || existing.error_message?.startsWith(RETRIEVAL_APPLYING_PREFIX))) {
    return "pending";
  }
  const result = await db.prepare(
    `INSERT INTO work_queue (id, task_type, payload, required_caps, priority, status, attempts, max_attempts)
     VALUES (?, 'scrape', ?, NULL, 5, 'queued', 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = 'queued', payload = excluded.payload, priority = excluded.priority,
       max_attempts = work_queue.attempts + ?, error_message = NULL,
       claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
       result_json = NULL, expires_at = NULL
     WHERE work_queue.task_type = 'scrape'
       AND work_queue.status IN ('completed', 'failed', 'canceled')
       AND NOT (work_queue.status = 'completed' AND work_queue.error_message GLOB 'retrieval_apply:*')`,
  ).bind(taskId, JSON.stringify(payload), RETRIEVAL_RETRY_BUDGET,
    RETRIEVAL_RETRY_BUDGET).run();
  if (result.meta.changes === 1) return "queued";
  const current = await db.prepare("SELECT status, error_message FROM work_queue WHERE id = ?")
    .bind(taskId).first<{ status: string; error_message: string | null }>();
  if (current?.status === "completed" && current.error_message?.startsWith("retrieval_apply:")) return "pending";
  return current && ["queued", "claimed"].includes(current.status) ? "active" : "invalid";
}

metadataRetrievalRoutes.post("/work/scrape/dispatch", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ ok: false, error: "Body must be an object" }, 400);
  const request = body as { after?: unknown };
  if (request.after !== undefined && typeof request.after !== "string") {
    return c.json({ ok: false, error: "after must be a master id" }, 400);
  }
  if ((await getFeatureString(env, "scrape_enabled", "1")) !== "1") return c.json({ ok: false, error: "Metadata retrieval is disabled" }, 409);
  const sources = await getRetrievalSources(env);
  if (!sources.length) return c.json({ ok: false, error: "No metadata retrieval sources are enabled" }, 409);
  const rows = (await env.DB.prepare(
    `SELECT sm.id AS master_id, sm.title, sm.artist_id, sm.album_id, sm.album_artist_id,
            sm.lyrics, sm.updated_at AS master_updated_at, sm.cover_r2_key AS song_cover_r2_key,
            a.name AS album_name, a.year, a.compilation, a.cover_r2_key AS album_cover_r2_key,
            ar.name AS artist_name, aar.name AS album_artist_name,
            si.id AS instance_id, si.storage_uri, si.source_etag
     FROM song_masters sm
     JOIN albums a ON a.id = sm.album_id
     JOIN artists ar ON ar.id = sm.artist_id
     LEFT JOIN artists aar ON aar.id = sm.album_artist_id
     JOIN song_instances si ON si.id = (
       SELECT si2.id FROM song_instances si2
       WHERE si2.master_id = sm.id AND si2.source_type = 'original' AND si2.missing = 0
       ORDER BY si2.created_at, si2.id LIMIT 1
     )
     WHERE (? IS NULL OR sm.id > ?)
     ORDER BY sm.id LIMIT 100`,
  ).bind(request.after ?? null, request.after ?? null).all<{
    master_id: string; title: string; artist_id: string; album_id: string; album_artist_id: string | null;
    lyrics: string | null; master_updated_at: number; song_cover_r2_key: string | null;
    album_name: string; year: number | null; compilation: number; album_cover_r2_key: string | null;
    artist_name: string; album_artist_name: string | null; instance_id: string; storage_uri: string; source_etag: string | null;
  }>()).results;
  let enqueued = 0;
  let skipped = 0;
  for (const row of rows) {
    const coverR2Key = row.song_cover_r2_key || row.album_cover_r2_key;
    const needsRetrieval = metadataMissing(row.title, "title") || metadataMissing(row.artist_name, "artist") ||
      metadataMissing(row.album_name, "album") || metadataMissing(row.album_artist_name, "albumArtist") ||
      metadataMissing(row.year, "year") || metadataMissing(row.lyrics, "lyrics") || metadataMissing(coverR2Key, "cover");
    if (!needsRetrieval) { skipped++; continue; }
    const path = await sourceFolderLogicalPath(env.DB, row.instance_id);
    const recovered = recoverMetadataFromStoragePath(path, {
      title: metadataMissing(row.title, "title") ? "??" : row.title,
      artist: metadataMissing(row.artist_name, "artist") ? "??" : row.artist_name,
      album: metadataMissing(row.album_name, "album") ? "??" : row.album_name,
      albumArtist: row.album_artist_name || undefined,
    });
    const albumFolder = path ? albumNameFromSourcePath(path) : null;
    const snapshot: RetrievalSnapshot = {
      title: row.title, artist: row.artist_name, album: row.album_name,
      albumArtist: row.album_artist_name, year: row.year, lyrics: row.lyrics,
      coverR2Key, masterUpdatedAt: row.master_updated_at, albumFolder,
    };
    const identityAlbum = isKnownMetadataIdentity(recovered.album)
      ? recovered.album : albumFolder || recovered.album;
    const query = [recovered.title, recovered.artist, identityAlbum]
      .filter((value) => value && isKnownMetadataIdentity(value)).join(" ");
    if (!query) { skipped++; continue; }
    const payload = {
      kind: "metadata-retrieval", masterId: row.master_id, instanceId: row.instance_id,
      sourceUri: row.storage_uri, sourceEtag: row.source_etag, snapshot,
      identity: { title: recovered.title, artist: recovered.artist, album: identityAlbum },
      sources, query,
    };
    const status = await restartRetrievalTask(env.DB, payload);
    if (status === "queued") enqueued++;
    else skipped++;
  }
  if (enqueued) {
    try { await notifyCoordinator(env); }
    catch (error) { console.error("[work] coordinator notify failed:", error); }
  }
  return c.json({ ok: true, enqueued, skipped, scanned: rows.length,
    nextCursor: rows.length === 100 ? rows.at(-1)!.master_id : null });
});

export function isMetadataRetrievalPayload(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "metadata-retrieval";
}

export function isValidMetadataRetrievalResult(payload: Record<string, unknown>, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as RetrievalResult;
  if (result.kind !== "metadata-retrieval" || result.masterId !== payload.masterId ||
      result.instanceId !== payload.instanceId) return false;
  if (result.status === "no-match") return true;
  if (result.status !== "matched" || !result.match || typeof result.match !== "object" || Array.isArray(result.match)) return false;
  const match = result.match as Record<string, unknown>;
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const identity = payload.identity as { title?: unknown; artist?: unknown; album?: unknown } | undefined;
  const snapshot = payload.snapshot as { title?: unknown; artist?: unknown; album?: unknown } | undefined;
  const albumKnown = isKnownMetadataIdentity(identity?.album) || isKnownMetadataIdentity(snapshot?.album);
  return !!identity && typeof identity === "object" &&
    typeof match.source === "string" && sources.includes(match.source) &&
    typeof match.songId === "string" && !!match.songId.trim() &&
    typeof match.title === "string" && !!match.title.trim() &&
    typeof match.artist === "string" && !!match.artist.trim() &&
    (!albumKnown || (typeof match.album === "string" && !!match.album.trim())) &&
    (match.album === undefined || (typeof match.album === "string" && !!match.album.trim())) &&
    isCredibleMetadataMatch(match, identity) && matchesKnownSnapshot(match, snapshot ?? {});
}

interface RetrievalResult {
  kind?: unknown; masterId?: unknown; instanceId?: unknown; status?: unknown;
  reason?: unknown; match?: unknown; cover?: unknown;
}

async function writeRetrievalCover(
  env: Env, masterId: string, albumId: string, sourceUri: string,
  sourceEtag: string | null, taskId: string, cover: { data?: string; mime?: string },
): Promise<"saved" | "preserved" | "invalid"> {
  if (typeof cover.data !== "string" || cover.data.length > 266_668) return "invalid";
  let bytes: Uint8Array;
  try {
    const binary = atob(cover.data);
    if (!binary.length || binary.length > 200_000) return "invalid";
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch { return "invalid"; }
  const mime = cover.mime?.toLowerCase();
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  const gif = bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)));
  if (!((mime === "image/png" && png) || (mime === "image/jpeg" && jpeg) ||
      (mime === "image/webp" && webp) || (mime === "image/gif" && gif))) {
    return "invalid";
  }
  const current = await env.DB.prepare(
    `SELECT sm.album_id, sm.cover_r2_key AS song_cover, a.cover_r2_key AS album_cover
     FROM song_masters sm JOIN albums a ON a.id = sm.album_id
     JOIN song_instances si ON si.master_id = sm.id
     WHERE sm.id = ? AND si.storage_uri = ? AND si.source_etag IS ? AND si.missing = 0 AND si.source_type = 'original'`,
  ).bind(masterId, sourceUri, sourceEtag).first<{ album_id: string; song_cover: string | null; album_cover: string | null }>();
  if (!current || current.album_id !== albumId) return "preserved";
  if (current.song_cover?.trim() || current.album_cover?.trim()) return "preserved";
  const key = `covers/${albumId}/retrieval-${md5(taskId)}`;
  await env.MUSIC_BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  const updated = await env.DB.prepare(
    `UPDATE albums SET cover_r2_key = ?, updated_at = ? WHERE id = ? AND COALESCE(TRIM(cover_r2_key), '') = ''
     AND EXISTS (SELECT 1 FROM song_masters sm WHERE sm.id = ? AND sm.album_id = ? AND COALESCE(TRIM(sm.cover_r2_key), '') = '')
     AND EXISTS (SELECT 1 FROM song_instances si WHERE si.master_id = ? AND si.storage_uri = ?
       AND si.source_etag IS ? AND si.missing = 0 AND si.source_type = 'original')`,
  ).bind(key, Math.floor(Date.now() / 1000), albumId, masterId, albumId, masterId, sourceUri, sourceEtag).run();
  if (updated.meta.changes === 1) return "saved";
  const currentAlbum = await env.DB.prepare("SELECT cover_r2_key FROM albums WHERE id = ?")
    .bind(albumId).first<{ cover_r2_key: string | null }>();
  if (currentAlbum?.cover_r2_key === key) return "saved";
  await env.MUSIC_BUCKET.delete(key);
  return "preserved";
}

async function finishRetrievalCatalogReceipt(
  env: Env, taskId: string, payloadJson: string, result: unknown, receipt: string, albumId: string,
  lockMarker = receipt,
): Promise<ApplyAnnotation> {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const snapshot = payload.snapshot as RetrievalSnapshot;
    const r = result as RetrievalResult | null;
    if (!r || r.status !== "matched" || !r.cover || typeof r.cover !== "object") {
      const done = receipt.replace(/:cover$/, ":done");
      await env.DB.prepare("UPDATE work_queue SET error_message = ? WHERE id = ? AND error_message = ?")
        .bind(done, taskId, lockMarker).run();
      return { ok: true, masterId: String(payload.masterId) };
    }
    const cover = r.cover as { data?: string; mime?: string };
    const status = await writeRetrievalCover(env, String(payload.masterId), albumId,
      String(payload.sourceUri), (payload.sourceEtag as string | null) ?? null, taskId, cover);
    if (status === "invalid") {
      const done = receipt.replace(/:cover$/, ":done");
      await env.DB.prepare("UPDATE work_queue SET error_message = ? WHERE id = ? AND error_message = ?")
        .bind(done, taskId, lockMarker).run();
      return { ok: true, masterId: String(payload.masterId), reason: "invalid cover ignored" };
    }
    const done = receipt.replace(/:cover$/, ":done");
    await env.DB.prepare("UPDATE work_queue SET error_message = ? WHERE id = ? AND error_message = ?")
      .bind(done, taskId, lockMarker).run();
    return { ok: true, masterId: String(payload.masterId) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function applyCompletedRetrieval(
  env: Env, taskId: string, payloadJson: string, result: unknown,
): Promise<ApplyAnnotation> {
  const applying = `${RETRIEVAL_APPLYING_PREFIX}${crypto.randomUUID()}`;
  const queue = await env.DB.prepare("SELECT error_message FROM work_queue WHERE id = ? AND task_type = 'scrape' AND status = 'completed'")
    .bind(taskId).first<{ error_message: string | null }>();
  const catalog = queue?.error_message?.match(/^retrieval_apply:catalog:([^:]+):(cover|done)$/);
  const priorMarker = catalog ? queue!.error_message! : RETRIEVAL_APPLY_PENDING;
  const applyingMarker = catalog ? `${applying}:catalog:${catalog[1]}:${catalog[2]}` : applying;
  const acquired = await env.DB.prepare(
    `UPDATE work_queue SET error_message = ?, heartbeat_at = unixepoch()
     WHERE id = ? AND task_type = 'scrape' AND status = 'completed' AND error_message = ?`,
  ).bind(applyingMarker, taskId, priorMarker).run();
  if (acquired.meta.changes !== 1) return { ok: false, reason: "retrieval apply already in progress" };
  if (catalog) {
    const receipt = await finishRetrievalCatalogReceipt(env, taskId, payloadJson, result, `retrieval_apply:catalog:${catalog[1]}:${catalog[2]}`, catalog[1], applyingMarker);
    const doneMarker = priorMarker.replace(/:cover$/, ":done");
    if (receipt.ok) await env.DB.prepare("UPDATE work_queue SET error_message = NULL WHERE id = ? AND status = 'completed' AND error_message = ?")
      .bind(taskId, doneMarker).run();
    else await env.DB.prepare("UPDATE work_queue SET error_message = ? WHERE id = ? AND status = 'completed' AND error_message = ?")
      .bind(priorMarker, taskId, applyingMarker).run();
    return receipt;
  }
  let annotation: ApplyAnnotation = { ok: false, reason: "invalid retrieval result" };
  let retry = false;
  let completedReceipt: string | null = null;
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const r = result as RetrievalResult | null;
    const snapshot = payload.snapshot as RetrievalSnapshot | undefined;
    if (!snapshot || payload.kind !== "metadata-retrieval" || !r || r.kind !== "metadata-retrieval" ||
        r.masterId !== payload.masterId || r.instanceId !== payload.instanceId ||
        typeof r.masterId !== "string" || typeof r.instanceId !== "string") {
      annotation = { ok: false, reason: "task result identity mismatch" };
    } else if (r.status === "no-match") {
      annotation = { ok: true, reason: typeof r.reason === "string" ? r.reason.slice(0, 160) : "no match" };
    } else if (r.status === "matched" && r.match && typeof r.match === "object") {
      const match = r.match as Record<string, unknown>;
      const current = await env.DB.prepare(
        `SELECT sm.id, sm.title, sm.sort_title, sm.lyrics, sm.updated_at, sm.cover_r2_key AS song_cover_r2_key,
                sm.artist_id, sm.album_id, sm.album_artist_id, a.name AS album_name, a.year, a.compilation,
                a.cover_r2_key AS album_cover_r2_key, ar.name AS artist_name, aar.name AS album_artist_name,
                si.storage_uri, si.source_etag, si.missing, si.source_type
         FROM song_masters sm JOIN albums a ON a.id = sm.album_id
         JOIN artists ar ON ar.id = sm.artist_id LEFT JOIN artists aar ON aar.id = sm.album_artist_id
         JOIN song_instances si ON si.id = ? AND si.master_id = sm.id WHERE sm.id = ?`,
      ).bind(payload.instanceId, payload.masterId).first<{
        id: string; title: string; sort_title: string | null; lyrics: string | null; updated_at: number; song_cover_r2_key: string | null;
        artist_id: string; album_id: string; album_artist_id: string | null; album_name: string; year: number | null; compilation: number;
        album_cover_r2_key: string | null; artist_name: string; album_artist_name: string | null;
        storage_uri: string; source_etag: string | null; missing: number; source_type: string;
      }>();
      const sourceList = Array.isArray(payload.sources) ? payload.sources : [];
      const fieldsCurrent = current && current.title === snapshot.title && current.artist_name === snapshot.artist &&
        current.album_name === snapshot.album && current.album_artist_name === snapshot.albumArtist &&
        current.year === snapshot.year && current.lyrics === snapshot.lyrics &&
        current.updated_at === snapshot.masterUpdatedAt &&
        (current.song_cover_r2_key || current.album_cover_r2_key) === snapshot.coverR2Key;
      if (!current || current.storage_uri !== payload.sourceUri || current.source_etag !== (payload.sourceEtag ?? null) ||
          current.missing !== 0 || current.source_type !== "original" || !fieldsCurrent) {
        annotation = { ok: false, reason: "source or metadata changed since retrieval was queued" };
      } else if (typeof match.source !== "string" || !sourceList.includes(match.source) ||
          typeof match.songId !== "string" || !match.songId.trim() ||
          !payload.identity || typeof payload.identity !== "object" || Array.isArray(payload.identity) ||
          !isCredibleMetadataMatch(match, payload.identity as { title?: unknown; artist?: unknown; album?: unknown }) || !matchesKnownSnapshot(match, snapshot)) {
        annotation = { ok: false, reason: "provider match is not credible for this song" };
      } else {
        const title = metadataMissing(current.title, "title") && typeof match.title === "string" ? match.title.trim() : current.title;
        const artistMissing = metadataMissing(current.artist_name, "artist") && typeof match.artist === "string";
        const albumMissing = metadataMissing(current.album_name, "album") && typeof match.album === "string";
        const albumArtistMissing = metadataMissing(current.album_artist_name, "albumArtist") && (current.compilation !== 0 || typeof match.albumArtist === "string");
        const yearMissing = metadataMissing(current.year, "year") && Number.isInteger(match.year) && Number(match.year) > 0;
        const lyricsMissing = metadataMissing(current.lyrics, "lyrics") && typeof match.lyrics === "string" && !!match.lyrics.trim();
        const now = Math.floor(Date.now() / 1000);
        const artistCredits = artistMissing ? parseArtistCredits(match.artist as string) : [];
        const primaryArtist = artistCredits[0];
        const albumArtistCredit = albumArtistMissing
          ? parseAlbumArtistCredit(current.compilation ? "Various Artists" : typeof match.albumArtist === "string" ? match.albumArtist : "")
          : null;
        const statements = artistInsertStatements(env.DB, [...artistCredits, ...(albumArtistCredit ? [albumArtistCredit] : [])], now);
        const currentCoverMissing = !current.song_cover_r2_key?.trim() && !current.album_cover_r2_key?.trim();
        const titleMissing = metadataMissing(current.title, "title") && typeof match.title === "string" && !!match.title.trim();
        const albumName = albumMissing && typeof match.album === "string"
          ? (snapshot.albumFolder || match.album.trim()) : current.album_name;
        const albumIdentityArtist = albumArtistCredit?.name || current.album_artist_name ||
          primaryArtist?.name || current.artist_name;
        const albumId = albumMissing && typeof match.album === "string"
          ? `al-${md5(`${albumIdentityArtist} ${albumName}`).substring(0, 10)}`
          : current.album_id;
        if (albumId !== current.album_id) {
          statements.push(env.DB.prepare(
            `INSERT OR IGNORE INTO albums (id, name, sort_name, year, compilation, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(albumId, albumName, albumName.toLowerCase(), yearMissing ? Number(match.year) : null, current.compilation, now, now));
        }
        const masterUpdateIndex = statements.length;
        const coverQueued = (currentCoverMissing || albumId !== current.album_id) && !!r.cover;
        const catalogReceipt = `retrieval_apply:catalog:${albumId}:${coverQueued ? "cover" : "done"}`;
        completedReceipt = catalogReceipt;
        statements.push(env.DB.prepare(
          `UPDATE song_masters SET title = ?, sort_title = ?, artist_id = ?, album_artist_id = ?, album_id = ?,
             lyrics = ?, updated_at = ? WHERE id = ? AND album_id = ? AND title = ? AND lyrics IS ?
             AND artist_id = ? AND album_artist_id IS ? AND updated_at = ?
             AND EXISTS (SELECT 1 FROM work_queue WHERE id = ? AND status = 'completed' AND error_message = ?)
             AND EXISTS (SELECT 1 FROM artists WHERE id = song_masters.artist_id AND name = ?)
             AND (SELECT name FROM artists WHERE id = song_masters.album_artist_id) IS ?
             AND COALESCE(cover_r2_key, '') = ?
             AND EXISTS (SELECT 1 FROM albums WHERE id = ? AND name = ? AND year IS ?
               AND COALESCE(cover_r2_key, '') = ?)
             AND EXISTS (SELECT 1 FROM song_instances WHERE id = ? AND master_id = ?
               AND storage_uri = ? AND source_etag IS ? AND missing = 0 AND source_type = 'original')`,
        ).bind(
          title, titleMissing ? title.toLowerCase() : current.sort_title, primaryArtist?.id ?? current.artist_id,
          albumArtistCredit?.id ?? current.album_artist_id, albumId,
          lyricsMissing ? (match.lyrics as string).trim() : current.lyrics,
          now, current.id, current.album_id, current.title, current.lyrics, current.artist_id,
          current.album_artist_id, snapshot.masterUpdatedAt, taskId, applying, current.artist_name, current.album_artist_name, current.song_cover_r2_key || "",
          current.album_id, current.album_name, current.year,
          current.album_cover_r2_key || "", payload.instanceId, current.id, payload.sourceUri,
          payload.sourceEtag ?? null,
        ));
        statements.push(env.DB.prepare(
          "UPDATE work_queue SET error_message = ?, heartbeat_at = unixepoch() WHERE id = ? AND status = 'completed' AND error_message = ? AND changes() = 1"
        ).bind(catalogReceipt, taskId, applying));
        if (yearMissing && albumId === current.album_id) statements.push(env.DB.prepare(
          `UPDATE albums SET year = ?, updated_at = ? WHERE id = ? AND name = ? AND year IS ?
             AND EXISTS (SELECT 1 FROM work_queue WHERE id = ? AND error_message = ?)`,
        ).bind(Number(match.year), now, current.album_id, current.album_name, current.year, taskId, catalogReceipt));
        if (artistMissing && primaryArtist) {
          statements.push(env.DB.prepare(
            "DELETE FROM song_artists WHERE song_id = ? AND EXISTS (SELECT 1 FROM work_queue WHERE id = ? AND error_message = ?)"
          ).bind(current.id, taskId, catalogReceipt));
          for (const credit of artistCredits) statements.push(env.DB.prepare(
            `INSERT OR IGNORE INTO song_artists (song_id, artist_id, position)
             SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM work_queue WHERE id = ? AND error_message = ?)`,
          ).bind(current.id, credit.id, credit.position, taskId, catalogReceipt));
        }
        for (const id of new Set([current.album_id, albumId])) statements.push(env.DB.prepare(
          `UPDATE albums SET song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = ?),
            duration = (SELECT COALESCE(SUM(duration), 0) FROM song_masters WHERE album_id = ?),
            size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = ?)
           WHERE id = ? AND EXISTS (SELECT 1 FROM work_queue WHERE id = ? AND error_message = ?)`
        ).bind(id, id, id, id, taskId, catalogReceipt));
        const batchResults = await env.DB.batch(statements);
        if (batchResults[masterUpdateIndex]?.meta?.changes !== 1) {
          annotation = { ok: false, reason: "source or metadata changed during retrieval apply" };
          retry = true;
          if (albumId !== current.album_id) {
            await env.DB.prepare("DELETE FROM albums WHERE id = ? AND NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = ?)")
              .bind(albumId, albumId).run();
          }
        } else {
          annotation = { ok: true, masterId: current.id };
          const coverState = await finishRetrievalCatalogReceipt(env, taskId, payloadJson, result, catalogReceipt, albumId);
          if (!coverState.ok) { retry = true; annotation = { ok: false, reason: coverState.reason }; }
          else if (coverState.reason) annotation = coverState;
        }
      }
    }
  } catch (error) {
    retry = true;
    annotation = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  await env.DB.prepare(
    `UPDATE work_queue SET error_message = ? WHERE id = ? AND status = 'completed'
      AND (error_message = ? OR (? IS NOT NULL AND error_message = ?))`,
  ).bind(retry ? RETRIEVAL_APPLY_PENDING : null, taskId, applying, completedReceipt ? 1 : null,
    completedReceipt ? completedReceipt.replace(/:cover$/, ':done') : '').run();
  return annotation;
}

export async function recoverPendingRetrievalApplies(env: Env, limit = 20): Promise<number> {
  await env.DB.prepare(
    `UPDATE work_queue SET error_message = CASE
       WHEN instr(error_message, ':catalog:') > 0 THEN 'retrieval_apply:catalog:' || substr(error_message, instr(error_message, ':catalog:') + 9)
       ELSE ? END
     WHERE status = 'completed' AND task_type = 'scrape'
       AND error_message GLOB 'retrieval_apply:applying:*'
       AND heartbeat_at < unixepoch() - ?`,
  ).bind(RETRIEVAL_APPLY_PENDING, RETRIEVAL_APPLY_LEASE_SECONDS).run();
  const rows = (await env.DB.prepare(
    `SELECT id, payload, result_json FROM work_queue
     WHERE status = 'completed' AND task_type = 'scrape' AND (error_message = ? OR error_message GLOB 'retrieval_apply:catalog:*')
     ORDER BY heartbeat_at ASC LIMIT ?`,
  ).bind(RETRIEVAL_APPLY_PENDING, Math.max(1, Math.min(limit, 100))).all<{
    id: string; payload: string; result_json: string | null;
  }>()).results;
  for (const row of rows) {
    let result: unknown = null;
    try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { /* invalid saved result is terminal */ }
    try { await applyCompletedRetrieval(env, row.id, row.payload, result); }
    catch (error) { console.error(`[work/recover] retrieval apply failed for ${row.id}:`, error); }
  }
  return rows.length;
}
