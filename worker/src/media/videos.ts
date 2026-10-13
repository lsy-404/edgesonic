// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StreamResult } from "../adapters/index";
import { parseStorageUri } from "../adapters/index";
import { createR2Adapter } from "../adapters/r2";
import { urlAdapter } from "../adapters/url";
import { createWebDAVAdapter } from "../adapters/webdav";
import { requestMedia, resolveExternalMedia, uploadVideoMedia, type MediaSession } from "./loader";
import { findMediaSession, forgetMediaSession, rememberMediaSession } from "./sessions";

export type VideoProvider = "file" | "youtube" | "bilibili";

export interface VideoSummary {
  id: string;
  title: string;
  provider: VideoProvider;
  duration: number | null;
  width: number | null;
  height: number | null;
  suffix: string | null;
  contentType: string | null;
  size: number | null;
}

export interface Video extends VideoSummary {
  sourceId: string | null;
  storageEntryId: string | null;
  storageUri: string | null;
  externalUrl: string | null;
  revision: string;
}

interface VideoRow {
  id: string;
  title: string;
  provider: VideoProvider;
  duration: number | null;
  width: number | null;
  height: number | null;
  suffix: string | null;
  content_type: string | null;
  size: number | null;
  source_id: string | null;
  storage_entry_id: string | null;
  storage_uri: string | null;
  external_url: string | null;
  revision: string;
}

const VIDEO_SUFFIXES = new Set(["mp4", "mkv", "webm", "mov", "m4v", "avi"]);

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm",
  mov: "video/quicktime", m4v: "video/x-m4v", avi: "video/x-msvideo",
};

export function isVideoSuffix(suffix: string): boolean {
  return VIDEO_SUFFIXES.has(suffix.replace(/^\./, "").toLowerCase());
}

export function videoContentType(suffix: string): string {
  return VIDEO_MIME[suffix.toLowerCase()] || "application/octet-stream";
}

function resolvedVideoContentType(contentType: string | null | undefined, suffix: string): string {
  const normalized = (contentType || "").split(";", 1)[0].trim().toLowerCase();
  return normalized && normalized !== "application/octet-stream"
    ? contentType!
    : videoContentType(suffix);
}

function toVideo(row: VideoRow): Video {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    duration: row.duration,
    width: row.width,
    height: row.height,
    suffix: row.suffix,
    contentType: row.content_type,
    size: row.size,
    sourceId: row.source_id,
    storageEntryId: row.storage_entry_id,
    storageUri: row.storage_uri,
    externalUrl: row.external_url,
    revision: row.revision,
  };
}

export function videoSummary(video: Video): VideoSummary {
  return {
    id: video.id,
    title: video.title,
    provider: video.provider,
    duration: video.duration,
    width: video.width,
    height: video.height,
    suffix: video.suffix,
    contentType: video.contentType,
    size: video.size,
  };
}

const SELECT_VIDEO = `SELECT v.id, v.title, v.provider, v.duration, v.width, v.height,
  v.suffix, v.content_type, v.size, v.source_id, v.storage_entry_id, v.storage_uri, v.external_url, v.revision
  FROM videos v`;
const AVAILABLE_VIDEO = `v.missing = 0 AND (v.provider != 'file' OR EXISTS (
  SELECT 1 FROM storage_sources ss WHERE ss.id = v.source_id AND ss.enabled = 1
))`;

export async function getVideo(env: Env, id: string): Promise<Video | null> {
  const row = await env.DB.prepare(`${SELECT_VIDEO} WHERE v.id = ? AND ${AVAILABLE_VIDEO}`)
    .bind(id).first<VideoRow>();
  return row ? toVideo(row) : null;
}

export async function listVideos(
  env: Env,
  query = "",
  offset = 0,
  limit = 50,
): Promise<{ videos: VideoSummary[]; total: number }> {
  const q = query.trim();
  const filter = q ? " AND v.title LIKE ? ESCAPE '\\'" : "";
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM videos v WHERE ${AVAILABLE_VIDEO}${filter}`,
  ).bind(...(q ? [pattern] : [])).first<{ total: number }>();
  const rows = await env.DB.prepare(
    `${SELECT_VIDEO} WHERE ${AVAILABLE_VIDEO}${filter} ORDER BY lower(v.title), v.id LIMIT ? OFFSET ?`,
  ).bind(...(q ? [pattern, limit, offset] : [limit, offset])).all<VideoRow>();
  return { videos: rows.results.map((row) => videoSummary(toVideo(row))), total: count?.total || 0 };
}

function pathTitle(path: string): string {
  const name = path.split("/").pop() || path;
  return name.replace(/\.[^.]+$/, "") || name;
}

function id(): string {
  return `vi-${crypto.randomUUID().replace(/-/g, "")}`;
}

interface VideoSessionCache {
  username: string;
  videoId: string;
  revision: string;
  sessionId: string;
}

function videoSessionCacheKey(username: string, video: Video): string {
  return `video_session:${encodeURIComponent(username)}:${video.id}:${encodeURIComponent(video.revision)}`;
}

async function cachedVideoSession(env: Env, username: string, video: Video): Promise<MediaSession | null> {
  const key = videoSessionCacheKey(username, video);
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  let cached: VideoSessionCache;
  try { cached = JSON.parse(row.value) as VideoSessionCache; }
  catch {
    await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
    return null;
  }
  if (cached.username !== username || cached.videoId !== video.id || cached.revision !== video.revision) {
    await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
    return null;
  }
  const session = await findMediaSession(env, username, cached.sessionId);
  if (!session) await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
  return session;
}

async function rememberVideoSession(env: Env, username: string, video: Video, session: MediaSession): Promise<void> {
  await rememberMediaSession(env, username, session);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(videoSessionCacheKey(username, video), JSON.stringify({
        username, videoId: video.id, revision: video.revision, sessionId: session.id,
      } satisfies VideoSessionCache), now),
    env.DB.prepare("DELETE FROM kv_store WHERE key LIKE 'video_session:%' AND updated_at < ?").bind(now - 86_400),
  ]);
}

export async function videoSessionMatches(env: Env, username: string, video: Video, sessionId: string): Promise<boolean> {
  const session = await cachedVideoSession(env, username, video);
  return session?.id === sessionId;
}

export async function invalidateVideoSession(env: Env, username: string, video: Video, sessionId?: string): Promise<void> {
  const key = videoSessionCacheKey(username, video);
  const session = await cachedVideoSession(env, username, video);
  if (!session || (sessionId && session.id !== sessionId)) return;
  await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
  await forgetMediaSession(env, session.id);
}

function normalizeExternalVideoReference(input: string): { provider: "youtube" | "bilibili"; url: string } {
  const value = input.trim().replace(/^av\s+(\d+)$/i, "av$1");
  if (/^BV[0-9A-Za-z]{10}$/i.test(value) || /^av\d+$/i.test(value)) {
    const ref = /^BV/i.test(value) ? value : value.toLowerCase();
    return { provider: "bilibili", url: `https://www.bilibili.com/video/${ref}?p=1` };
  }
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); }
  catch { throw new Error("Invalid video URL"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Invalid video URL");
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com" || host === "youtu.be") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const videoId = host === "youtu.be" ? parts[0]
      : parsed.searchParams.get("v") || (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" ? parts[1] : null);
    if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error("Invalid YouTube video reference");
    return { provider: "youtube", url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` };
  }
  if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
    const videoId = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i)?.[1];
    if (videoId) {
      const parts = parsed.searchParams.getAll("p");
      if (parts.length > 1 || (parts.length === 1 && !/^[1-9][0-9]*$/.test(parts[0]))) throw new Error("Invalid Bilibili part");
      return { provider: "bilibili", url: `https://www.bilibili.com/video/${/^BV/i.test(videoId) ? videoId : videoId.toLowerCase()}?p=${parts[0] || "1"}` };
    }
  }
  if (host === "b23.tv" && parsed.pathname !== "/") {
    return { provider: "bilibili", url: `https://b23.tv${parsed.pathname}` };
  }
  throw new Error("Only YouTube and Bilibili URLs are supported");
}

export async function saveExternalVideo(env: Env, url: string, signal?: AbortSignal): Promise<Video> {
  if (url.length > 2048) throw new Error("Video URL is too long");
  const normalized = normalizeExternalVideoReference(url);
  const existing = await env.DB.prepare(`${SELECT_VIDEO} WHERE v.provider = ? AND v.external_url = ?`)
    .bind(normalized.provider, normalized.url).first<VideoRow>();
  if (existing) return toVideo(existing);
  const session = await resolveExternalMedia(env, normalized.url, signal);
  try {
    const now = Math.floor(Date.now() / 1000);
    const videoId = id();
    const revision = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO videos (id, provider, title, duration, width, height, external_url, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, external_url) WHERE external_url IS NOT NULL DO UPDATE SET title = excluded.title,
         duration = excluded.duration, width = excluded.width, height = excluded.height,
         revision = excluded.revision, updated_at = excluded.updated_at`,
    ).bind(videoId, normalized.provider, session.title, session.duration, session.width, session.height,
      normalized.url, revision, now, now).run();
    const saved = await env.DB.prepare(`${SELECT_VIDEO} WHERE v.provider = ? AND v.external_url = ?`)
      .bind(normalized.provider, normalized.url).first<VideoRow>();
    if (!saved) throw new Error("Video could not be saved");
    return toVideo(saved);
  } finally {
    await requestMedia(env, `/media/sessions/${session.id}`, { method: "DELETE", signal: AbortSignal.timeout(5000) })
      .then((response) => response.body?.cancel()).catch(() => undefined);
  }
}

interface StorageFileRow {
  source_id: string;
  type: "r2" | "webdav" | "s3";
  enabled: number;
  physical_key: string | null;
  suffix: string | null;
  content_type: string | null;
  size: number | null;
  etag: string | null;
  last_modified: number | null;
  entry_id: string | null;
}

async function storageStream(env: Env, uri: string, range?: string): Promise<StreamResult> {
  const parsed = parseStorageUri(uri);
  switch (parsed.scheme) {
    case "r2": return createR2Adapter(env.MUSIC_BUCKET).stream(uri, range);
    case "url": return urlAdapter.stream(uri, range);
    case "webdav": return createWebDAVAdapter(env.DB, env).stream(uri, range);
    case "s3": {
      const { getS3Config } = await import("../adapters/index");
      const { createS3Adapter } = await import("../adapters/s3");
      const config = await getS3Config(env.DB, parsed.sourceId);
      if (!config) throw new Error("Storage source is disabled or unavailable");
      return createS3Adapter(config).stream(uri, range);
    }
    default: throw new Error("Unsupported video storage source");
  }
}

export async function importStorageVideo(env: Env, sourceId: string, path: string): Promise<Video> {
  const cleanPath = path.replace(/^\/+|\/+$/g, "");
  if (!cleanPath || cleanPath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid storage path");
  }
  const suffix = cleanPath.split(".").pop()?.toLowerCase() || "";
  if (!isVideoSuffix(suffix)) throw new Error("Unsupported video file type");
  if (sourceId === "r2-local") {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO storage_sources (id, type, name, base_url, root_path, mode, enabled, created_at, updated_at)
       VALUES ('r2-local', 'r2', 'R2', '', '', 'library', 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(now, now).run();
  }
  const source = await env.DB.prepare(
    `SELECT ss.id AS source_id, ss.type, ss.enabled, se.id AS entry_id,
            se.object_id, so.physical_key, so.suffix, so.content_type, so.size,
            so.etag, so.last_modified
       FROM storage_sources ss
       LEFT JOIN storage_entries se ON se.source_id = ss.id AND se.path = ? AND se.kind = 'file'
       LEFT JOIN storage_objects so ON so.id = se.object_id
      WHERE ss.id = ? AND ss.enabled = 1 LIMIT 1`,
  ).bind(cleanPath, sourceId).first<StorageFileRow>();
  if (!source) throw new Error("Storage source is disabled or unavailable");
  const uri = source.type === "r2"
    ? `r2://${source.physical_key || cleanPath}`
    : `${source.type}://${source.source_id}/${cleanPath}`;
  const result = await storageStream(env, uri, "bytes=0-0");
  if (!result.body || result.statusCode >= 400) throw new Error("Storage file was not found");
  await result.body.cancel();
  const actualSuffix = source.suffix?.toLowerCase() || suffix;
  if (!isVideoSuffix(actualSuffix)) throw new Error("Storage file was not found");
  const totalSize = source.size ?? (result.contentRange
    ? Number(/\/(\d+)$/.exec(result.contentRange)?.[1]) || null
    : result.contentLength);
  const now = Math.floor(Date.now() / 1000);
  const videoId = id();
  await saveFileVideo(env, {
    sourceId: source.source_id, storageUri: uri, storageEntryId: source.entry_id,
    title: pathTitle(cleanPath), suffix: actualSuffix,
    contentType: resolvedVideoContentType(source.content_type || result.contentType, actualSuffix),
    size: totalSize, revision: `${source.etag || ""}:${source.last_modified || ""}:${totalSize ?? ""}:${actualSuffix}`,
    now, newId: videoId,
  });
  const saved = await env.DB.prepare(`${SELECT_VIDEO} WHERE v.source_id = ? AND v.storage_uri = ?`)
    .bind(source.source_id, uri).first<VideoRow>();
  if (!saved) throw new Error("Video could not be imported");
  return toVideo(saved);
}

export async function registerUploadedVideo(env: Env, input: {
  sourceId: string; storageUri: string; storageEntryId: string | null; title: string;
  suffix: string; contentType: string; size: number;
}): Promise<Video> {
  const now = Math.floor(Date.now() / 1000);
  const videoId = id();
  await saveFileVideo(env, {
    sourceId: input.sourceId, storageUri: input.storageUri, storageEntryId: input.storageEntryId,
    title: input.title, suffix: input.suffix, contentType: input.contentType, size: input.size, now, newId: videoId,
    revision: crypto.randomUUID(),
  });
  const saved = await env.DB.prepare(`${SELECT_VIDEO} WHERE v.source_id = ? AND v.storage_uri = ?`)
    .bind(input.sourceId, input.storageUri).first<VideoRow>();
  if (!saved) throw new Error("Video could not be registered");
  return toVideo(saved);
}

async function saveFileVideo(env: Env, input: {
  sourceId: string; storageUri: string; storageEntryId: string | null; title: string;
  suffix: string; contentType: string; size: number | null; revision: string; now: number; newId: string;
}): Promise<void> {
  const existing = input.storageEntryId
    ? await env.DB.prepare("SELECT id FROM videos WHERE storage_entry_id = ?").bind(input.storageEntryId).first<{ id: string }>()
    : null;
  if (existing) {
    await env.DB.prepare(
      `UPDATE videos SET title = ?, suffix = ?, content_type = ?, size = ?, source_id = ?,
        storage_uri = ?, revision = ?, duration = NULL, width = NULL, height = NULL, missing = 0, updated_at = ? WHERE id = ?`,
    ).bind(input.title, input.suffix, input.contentType, input.size, input.sourceId,
      input.storageUri, input.revision, input.now, existing.id).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO videos (id, provider, title, suffix, content_type, size, source_id, revision,
       storage_entry_id, storage_uri, created_at, updated_at)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, storage_uri) WHERE storage_uri IS NOT NULL DO UPDATE SET title = excluded.title,
       suffix = excluded.suffix, content_type = excluded.content_type, size = excluded.size,
       revision = excluded.revision, duration = NULL, width = NULL, height = NULL,
       storage_entry_id = COALESCE(excluded.storage_entry_id, videos.storage_entry_id),
       missing = 0, updated_at = excluded.updated_at`,
  ).bind(input.newId, input.title, input.suffix, input.contentType, input.size, input.sourceId, input.revision,
    input.storageEntryId, input.storageUri, input.now, input.now).run();
}

export async function syncScannedVideos(db: D1Database, sourceId: string, type: "r2" | "webdav" | "s3",
  files: Array<{ path: string; size: number; contentType?: string | null; etag?: string | null; lastModified?: number | null }>, complete = false,
  listingHadItems = files.length > 0, mode?: string | null): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const source = await db.prepare("SELECT enabled FROM storage_sources WHERE id = ?").bind(sourceId).first<{ enabled: number }>();
  if (!source?.enabled) return;
  const seen = new Set<string>();
  for (const file of files) {
    const suffix = file.path.split(".").pop()?.toLowerCase() || "";
    if (!isVideoSuffix(suffix)) continue;
    let uri: string;
    let entryId: string | null = null;
    let actualPath = file.path;
    if (type === "r2") {
      const storage = await db.prepare(
        `SELECT e.id AS entry_id, e.path, o.physical_key
           FROM storage_entries e JOIN storage_objects o ON o.id = e.object_id
          WHERE e.source_id = ? AND e.kind = 'file' AND (o.physical_key = ? OR o.legacy_key = ?)
          LIMIT 1`,
      ).bind(sourceId, file.path, file.path).first<{ entry_id: string; path: string; physical_key: string }>();
      if (!storage) continue;
      entryId = storage.entry_id;
      actualPath = storage.path;
      uri = `r2://${storage.physical_key}`;
    } else {
      uri = `${type}://${sourceId}/${file.path}`;
    }
    seen.add(uri);
    const prior = entryId
      ? await db.prepare("SELECT id, size, suffix, content_type, revision FROM videos WHERE storage_entry_id = ?").bind(entryId)
        .first<{ id: string; size: number | null; suffix: string | null; content_type: string | null; revision: string }>()
      : await db.prepare("SELECT id, size, suffix, content_type, revision FROM videos WHERE source_id = ? AND storage_uri = ?")
        .bind(sourceId, uri).first<{ id: string; size: number | null; suffix: string | null; content_type: string | null; revision: string }>();
    if (prior) {
      const resolvedType = resolvedVideoContentType(file.contentType, suffix);
      const revision = `${file.etag || ""}:${file.lastModified || ""}:${file.size}:${suffix}`;
      const metadataChanged = prior.size !== file.size || prior.suffix !== suffix
        || prior.content_type !== resolvedType || prior.revision !== revision;
      await db.prepare(
        `UPDATE videos SET title = ?, storage_uri = ?, suffix = ?, content_type = ?, revision = ?,
          size = ?, duration = CASE WHEN ? THEN NULL ELSE duration END,
          width = CASE WHEN ? THEN NULL ELSE width END, height = CASE WHEN ? THEN NULL ELSE height END,
          missing = 0, updated_at = ? WHERE id = ?`,
      ).bind(pathTitle(actualPath), uri, suffix, resolvedType, revision, file.size, metadataChanged ? 1 : 0,
        metadataChanged ? 1 : 0, metadataChanged ? 1 : 0, now, prior.id).run();
      continue;
    }
    if (mode === "sync_only") continue;
    const revision = `${file.etag || ""}:${file.lastModified || ""}:${file.size}:${suffix}`;
    const result = await db.prepare(
      `INSERT INTO videos (id, provider, title, suffix, content_type, size, source_id, revision,
         storage_entry_id, storage_uri, created_at, updated_at)
       VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id(), pathTitle(actualPath), suffix, resolvedVideoContentType(file.contentType, suffix), file.size,
      sourceId, revision, entryId, uri, now, now).run();
    void result;
  }
  if (complete && listingHadItems) {
    const rows = await db.prepare("SELECT id, storage_uri FROM videos WHERE source_id = ? AND provider = 'file' AND missing = 0")
      .bind(sourceId).all<{ id: string; storage_uri: string }>();
    const gone = rows.results.filter((row) => !seen.has(row.storage_uri)).map((row) => row.id);
    for (let i = 0; i < gone.length; i += 80) {
      const chunk = gone.slice(i, i + 80);
      await db.prepare(`UPDATE videos SET missing = 1, updated_at = ? WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(now, ...chunk).run();
    }
  }
}

async function openVideoSource(env: Env, uri: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
  const result = await storageStream(env, uri);
  if (!result.body || result.statusCode >= 400) throw new Error("Video file is unavailable");
  return { body: result.body, contentType: result.contentType };
}

export async function prepareVideoMedia(
  env: Env,
  video: Video,
  username: string,
  signal?: AbortSignal,
  reuseSession = true,
): Promise<MediaSession> {
  const cached = reuseSession ? await cachedVideoSession(env, username, video) : null;
  if (cached) return cached;
  if (video.provider === "file") {
    if (!video.storageUri) throw new Error("Video file is unavailable");
    const source = await openVideoSource(env, video.storageUri);
    const session = await uploadVideoMedia(env, source.body, video.title, video.suffix || "mp4", signal);
    await env.DB.prepare("UPDATE videos SET duration = ?, width = ?, height = ? WHERE id = ?")
      .bind(session.duration, session.width, session.height, video.id).run();
    if (reuseSession) await rememberVideoSession(env, username, video, session);
    else await rememberMediaSession(env, username, session);
    return session;
  }
  if (!video.externalUrl) throw new Error("External video is unavailable");
  const session = await resolveExternalMedia(env, video.externalUrl, signal);
  await env.DB.prepare("UPDATE videos SET title = ?, duration = ?, width = ?, height = ? WHERE id = ?")
    .bind(session.title, session.duration, session.width, session.height, video.id).run();
  if (reuseSession) await rememberVideoSession(env, username, video, session);
  else await rememberMediaSession(env, username, session);
  return session;
}

export async function rawVideoResponse(env: Env, video: Video, request: Request, asAttachment = false): Promise<Response> {
  if (video.provider !== "file" || !video.storageUri) return new Response("Not found", { status: 404 });
  const result = await storageStream(env, video.storageUri, request.headers.get("Range") || undefined);
  const headers = new Headers({
    "Content-Type": resolvedVideoContentType(video.contentType || result.contentType, video.suffix || ""),
    "Accept-Ranges": result.acceptRanges ? "bytes" : "none",
    "Cache-Control": "private, no-store",
  });
  if (result.contentLength != null) headers.set("Content-Length", String(result.contentLength));
  if (result.contentRange) headers.set("Content-Range", result.contentRange);
  if (!result.body || result.statusCode >= 400) return new Response(null, { status: result.statusCode, headers });
  if (asAttachment) headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${video.title}.${video.suffix || "mp4"}`)}`);
  return new Response(result.body, { status: result.statusCode, headers });
}
