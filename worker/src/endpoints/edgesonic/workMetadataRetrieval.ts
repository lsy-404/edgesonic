// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { getFeature, getFeatureString, invalidateFeature } from "../../utils/features";
import { albumNameFromSourcePath, recoverMetadataFromStoragePath, sourceFolderLogicalPath } from "../../utils/storageMetadata";
import { artistInsertStatements, parseAlbumArtistCredit, parseArtistCredits, songArtistStatements } from "../../utils/artistCredits";
import { md5 } from "../../utils/md5";
import { normalizeMetadataIdentity, isKnownMetadataIdentity, isCredibleMetadataMatch, isSelectableMetadataMatch } from "../../../../shared/metadataRetrievalMatch";
import { notifyCoordinator } from "../../coordinator/workCoordinator";
import type { User } from "../../types/entities";

export const metadataRetrievalRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

interface ApplyAnnotation { ok: boolean; reason?: string; masterId?: string }

export const RETRIEVAL_APPLY_PENDING = "retrieval_apply:pending";
export const RETRIEVAL_REVIEW_PENDING = "retrieval_review:pending";
export const RETRIEVAL_REVIEW_KEPT = "retrieval_review:kept";
const RETRIEVAL_APPLYING_PREFIX = "retrieval_apply:applying:";
const RETRIEVAL_APPLY_LEASE_SECONDS = 10 * 60;
const RETRIEVAL_SOURCES = new Set(["lrc", "netease", "qmusic", "kugou"]);
const RETRIEVAL_RETRY_BUDGET = 3;
const RETRIEVAL_AUTO_INTERVAL_SECONDS = 60;
const RETRIEVAL_AUTO_QUEUE_CAP = 40;
const RETRIEVAL_AUTO_ENQUEUE_CAP = 20;
const RETRIEVAL_SCAN_LIMIT = 100;

interface RetrievalSnapshot {
  title: string; artist: string; album: string; albumArtist: string | null;
  year: number | null; lyrics: string | null; coverR2Key: string | null;
  masterUpdatedAt: number; albumFolder: string | null;
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

function isMetadataIdentityRecord(value: unknown): value is { title?: unknown; artist?: unknown; album?: unknown } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function retrieveCurrentHints(
  db: D1Database,
  instanceId: string,
  current: { title: string; artist: string; album: string; albumArtist: string | null },
): Promise<{ identity: { title: string; artist: string; album: string }; query: string; albumFolder: string | null }> {
  const path = await sourceFolderLogicalPath(db, instanceId);
  const recovered = recoverMetadataFromStoragePath(path, {
    title: metadataMissing(current.title, "title") ? "??" : current.title,
    artist: metadataMissing(current.artist, "artist") ? "??" : current.artist,
    album: metadataMissing(current.album, "album") ? "??" : current.album,
    albumArtist: current.albumArtist || undefined,
  });
  const albumFolder = path ? albumNameFromSourcePath(path) : null;
  const identity = {
    title: recovered.title,
    artist: recovered.artist,
    album: isKnownMetadataIdentity(recovered.album) ? recovered.album : albumFolder || recovered.album,
  };
  return {
    identity,
    query: [identity.title, identity.artist, identity.album].filter(isKnownMetadataIdentity).join(" "),
    albumFolder,
  };
}

async function retrieveSourcePathState(
  db: D1Database,
  instanceId: string,
): Promise<{ count: number; uniquePath: string | null }> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count, CASE WHEN COUNT(*) = 1 THEN MIN(path) ELSE NULL END AS unique_path
     FROM storage_entries WHERE instance_id = ? AND kind = 'file'`,
  ).bind(instanceId).first<{ count: number; unique_path: string | null }>();
  return { count: row?.count ?? 0, uniquePath: row?.unique_path ?? null };
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
  allowTerminalRestart = false,
): Promise<"queued" | "active" | "pending" | "invalid"> {
  const masterId = payload.masterId;
  if (typeof masterId !== "string") return "invalid";
  const taskId = `wt-scrape-retrieve:${masterId}`;
  if (allowTerminalRestart) {
    const existing = await db.prepare(
      "SELECT task_type, status, attempts, error_message FROM work_queue WHERE id = ?",
    ).bind(taskId).first<{ task_type: string; status: string; attempts: number; error_message: string | null }>();
    if (existing?.error_message?.startsWith("retrieval_review:") || existing?.error_message?.startsWith("retrieval_apply:")) return "pending";
    if (existing && existing.task_type === "scrape" && ["completed", "failed", "canceled"].includes(existing.status)) {
      const restarted = await db.prepare(
        `UPDATE work_queue SET status='queued', payload=?, priority=5, max_attempts=attempts + ?, error_message=NULL,
           claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, result_json=NULL, expires_at=NULL
         WHERE id=? AND task_type='scrape' AND status IN ('completed','failed','canceled')
           AND (error_message IS NULL OR error_message NOT GLOB 'retrieval_apply:*')
           AND (error_message IS NULL OR error_message NOT GLOB 'retrieval_review:*')`,
      ).bind(JSON.stringify(payload), RETRIEVAL_RETRY_BUDGET, taskId).run();
      if (restarted.meta.changes === 1) return "queued";
    }
  }
  const result = await db.prepare(
    `INSERT OR IGNORE INTO work_queue (id, task_type, payload, required_caps, priority, status, attempts, max_attempts)
     VALUES (?, 'scrape', ?, NULL, 5, 'queued', 0, ?)`,
  ).bind(taskId, JSON.stringify(payload), RETRIEVAL_RETRY_BUDGET).run();
  if (result.meta.changes === 1) return "queued";
  const current = await db.prepare("SELECT status, error_message FROM work_queue WHERE id = ?")
    .bind(taskId).first<{ status: string; error_message: string | null }>();
  if (current && ["queued", "claimed"].includes(current.status)) return "active";
  return current?.error_message?.startsWith("retrieval_review:") ? "pending" : "invalid";
}

function missingIdentitySql(column: string): string {
  const value = `LOWER(REPLACE(REPLACE(TRIM(COALESCE(${column}, '')), '_', ' '), '-', ' '))`;
  return `(TRIM(COALESCE(${column}, '')) IN ('', '??') OR ${value} IN
    ('unknown','unknown artist','unknownartist','unknown album','unknownalbum','pending uploads','pendinguploads')
    OR LOWER(TRIM(COALESCE(${column}, ''))) GLOB 'obj_[0-9a-f]*')`;
}

function metadataIncompleteSql(): string {
  return `(${missingIdentitySql("sm.title")} OR ${missingIdentitySql("ar.name")} OR ${missingIdentitySql("a.name")}
    OR ${missingIdentitySql("aar.name")} OR a.year IS NULL OR a.year <= 0
    OR TRIM(COALESCE(sm.lyrics, '')) = ''
    OR (TRIM(COALESCE(sm.cover_r2_key, '')) = '' AND TRIM(COALESCE(a.cover_r2_key, '')) = ''))`;
}

async function dispatchRetrievalBatch(env: Env, after: string | null, limit: number, enqueueCap = Infinity, manualForce = false) {
  const sources = await getRetrievalSources(env);
  if (!sources.length) return { ok: false as const, error: "No metadata retrieval sources are enabled" };
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
       WHERE si2.master_id = sm.id AND si2.source_type = 'original' AND si2.missing = 0 ${manualForce ? "" : "AND si2.tag_scanned = 1"}
       ORDER BY si2.created_at, si2.id LIMIT 1
     )
     WHERE sm.id > ? AND ${metadataIncompleteSql()}
     ORDER BY sm.id LIMIT ?`,
  ).bind(after ?? "", limit).all<{
    master_id: string; title: string; artist_id: string; album_id: string; album_artist_id: string | null;
    lyrics: string | null; master_updated_at: number; song_cover_r2_key: string | null;
    album_name: string; year: number | null; compilation: number; album_cover_r2_key: string | null;
    artist_name: string; album_artist_name: string | null; instance_id: string; storage_uri: string; source_etag: string | null;
  }>()).results;
  let enqueued = 0;
  let skipped = 0;
  let processed = 0;
  for (const row of rows) {
    if (enqueued >= enqueueCap) break;
    processed++;
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
    const status = await restartRetrievalTask(env.DB, payload, manualForce);
    if (status === "queued") enqueued++;
    else skipped++;
  }
  if (enqueued) {
    try { await notifyCoordinator(env); }
    catch (error) { console.error("[work] coordinator notify failed:", error); }
  }
  const nextCursor = processed < rows.length
    ? processed > 0 ? rows[processed - 1]!.master_id : after
    : rows.length === limit ? rows.at(-1)!.master_id : null;
  return { ok: true as const, enqueued, skipped, scanned: processed, nextCursor };
}

metadataRetrievalRoutes.post("/work/scrape/dispatch", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ ok: false, error: "Body must be an object" }, 400);
  const request = body as { after?: unknown };
  if (request.after !== undefined && typeof request.after !== "string") return c.json({ ok: false, error: "after must be a master id" }, 400);
  if (!(await getFeature(env, "scrape_enabled"))) return c.json({ ok: false, error: "Metadata retrieval is disabled" }, 409);
  return c.json(await dispatchRetrievalBatch(env, request.after ?? null, RETRIEVAL_SCAN_LIMIT, Infinity, true));
});

metadataRetrievalRoutes.get("/work/scrape/auto", permissionMiddleware("dispatch_work"), async (c) => {
  return c.json({ ok: true, enabled: await getFeature(c.env as Env, "metadata_auto_retrieval") });
});

metadataRetrievalRoutes.post("/work/scrape/auto", permissionMiddleware("dispatch_work"), async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { enabled?: unknown }).enabled !== "boolean") {
    return c.json({ ok: false, error: "enabled must be a boolean" }, 400);
  }
  const enabled = (body as { enabled: boolean }).enabled;
  await c.env.DB.prepare(
    `INSERT INTO features (key, value, description, updated_at) VALUES ('metadata_auto_retrieval', ?, 'Automatic metadata retrieval', unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(enabled ? 1 : 0).run();
  invalidateFeature(c.env as Env, "metadata_auto_retrieval");
  if (enabled) c.executionCtx.waitUntil(maybeRunAutomaticMetadataRetrieval(c.env as Env).catch((error) => {
    console.error("metadata auto-retrieval immediate scan failed:", error);
  }));
  return c.json({ ok: true, enabled });
});

export async function maybeRunAutomaticMetadataRetrieval(env: Env): Promise<void> {
  if (!(await getFeature(env, "metadata_auto_retrieval")) || !(await getFeature(env, "scrape_enabled"))) return;
  const now = Math.floor(Date.now() / 1000);
  const lease = await env.DB.prepare(
    `INSERT INTO feature_strings (key, value, description, updated_at)
     VALUES ('metadata_auto_retrieval_last_run', ?, 'Automatic retrieval cadence gate', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE CAST(feature_strings.value AS INTEGER) <= ?
     RETURNING key`,
  ).bind(String(now), now, now - RETRIEVAL_AUTO_INTERVAL_SECONDS).first<{ key: string }>();
  if (!lease) return;
  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM work_queue WHERE task_type = 'scrape' AND status IN ('queued','claimed')",
  ).first<{ count: number }>();
  const available = Math.max(0, Math.min(RETRIEVAL_AUTO_ENQUEUE_CAP, RETRIEVAL_AUTO_QUEUE_CAP - (active?.count ?? 0)));
  if (available === 0) return;
  const cursor = await getFeatureString(env, "metadata_auto_retrieval_cursor", "");
  const result = await dispatchRetrievalBatch(env, cursor || null, RETRIEVAL_SCAN_LIMIT, available);
  if (!result.ok) return;
  const next = result.nextCursor ?? "";
  await env.DB.prepare(
    `INSERT INTO feature_strings (key, value, description, updated_at) VALUES ('metadata_auto_retrieval_cursor', ?, 'Automatic retrieval pagination cursor', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(next, now).run();
}

metadataRetrievalRoutes.get("/work/scrape/status", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;
  const rawAfter = c.req.query("after");
  const after = rawAfter?.trim() || null;
  if (rawAfter !== undefined && rawAfter.length > 200) return c.json({ ok: false, error: "after cursor is too long" }, 400);
  const pendingRows = (await env.DB.prepare(
    `SELECT id, attempts, payload, result_json FROM work_queue
     WHERE task_type = 'scrape' AND status = 'completed' AND error_message = ? AND (? IS NULL OR id > ?)
     ORDER BY id LIMIT 21`,
  ).bind(RETRIEVAL_REVIEW_PENDING, after, after).all<{ id: string; attempts: number; payload: string; result_json: string | null }>()).results;
  const hasMore = pendingRows.length > 20;
  const page = pendingRows.slice(0, 20).map((row) => {
    let payload: unknown = null;
    let result: unknown = null;
    try { payload = JSON.parse(row.payload); } catch { /* corrupt queue data stays reviewable */ }
    try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { /* corrupt queue data stays reviewable */ }
    return { taskId: row.id, attempts: row.attempts, payload, result };
  });
  const aggregate = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN ${metadataIncompleteSql()} THEN 1 ELSE 0 END) AS incomplete,
       SUM(CASE WHEN ${metadataIncompleteSql()} THEN 0 ELSE 1 END) AS complete
     FROM song_masters sm JOIN albums a ON a.id = sm.album_id JOIN artists ar ON ar.id = sm.artist_id
     LEFT JOIN artists aar ON aar.id = sm.album_artist_id
     WHERE EXISTS (SELECT 1 FROM song_instances si WHERE si.master_id = sm.id AND si.source_type = 'original' AND si.missing = 0)`
  ).first<{ total: number; incomplete: number; complete: number }>();
  const [pending, kept, queued, claimed] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM work_queue WHERE status='completed' AND task_type='scrape' AND error_message=?").bind(RETRIEVAL_REVIEW_PENDING).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM work_queue WHERE status='completed' AND task_type='scrape' AND error_message=?").bind(RETRIEVAL_REVIEW_KEPT).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM work_queue WHERE task_type='scrape' AND status='queued'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM work_queue WHERE task_type='scrape' AND status='claimed'").first<{ count: number }>(),
  ]);
  return c.json({ ok: true, autoEnabled: await getFeature(env, "metadata_auto_retrieval"),
    counts: { total: aggregate?.total ?? 0, incomplete: aggregate?.incomplete ?? 0, complete: aggregate?.complete ?? 0,
      pending: pending?.count ?? 0, kept: kept?.count ?? 0, queued: queued?.count ?? 0, claimed: claimed?.count ?? 0 },
    pending: page, nextCursor: hasMore ? pendingRows[19]?.id ?? null : null });
});

async function refreshRetrievalPayload(env: Env, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const masterId = payload.masterId;
  const instanceId = payload.instanceId;
  if (typeof masterId !== "string" || typeof instanceId !== "string") return null;
  const row = await env.DB.prepare(
    `SELECT sm.title, sm.lyrics, sm.updated_at, sm.cover_r2_key AS song_cover, a.name AS album_name, a.year,
       a.cover_r2_key AS album_cover, ar.name AS artist_name, aar.name AS album_artist_name,
       si.storage_uri, si.source_etag, si.missing, si.source_type
     FROM song_masters sm JOIN albums a ON a.id = sm.album_id JOIN artists ar ON ar.id = sm.artist_id
     LEFT JOIN artists aar ON aar.id = sm.album_artist_id JOIN song_instances si ON si.id = ? AND si.master_id = sm.id
     WHERE sm.id = ?`,
  ).bind(instanceId, masterId).first<{
    title: string; lyrics: string | null; updated_at: number; song_cover: string | null; album_name: string; year: number | null;
    album_cover: string | null; artist_name: string; album_artist_name: string | null; storage_uri: string;
    source_etag: string | null; missing: number; source_type: string;
  }>();
  if (!row || row.missing !== 0 || row.source_type !== "original") return null;
  const hints = await retrieveCurrentHints(env.DB, instanceId, {
    title: row.title, artist: row.artist_name, album: row.album_name, albumArtist: row.album_artist_name,
  });
  if (!hints.query) return null;
  const priorSnapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot as RetrievalSnapshot : null;
  return {
    ...payload,
    sourceUri: row.storage_uri,
    sourceEtag: row.source_etag,
    identity: hints.identity,
    query: hints.query,
    snapshot: {
      ...(priorSnapshot ?? {}),
      title: row.title, artist: row.artist_name, album: row.album_name, albumArtist: row.album_artist_name,
      year: row.year, lyrics: row.lyrics, coverR2Key: row.song_cover || row.album_cover,
      masterUpdatedAt: row.updated_at, albumFolder: hints.albumFolder,
    },
  };
}

metadataRetrievalRoutes.post("/work/scrape/review", permissionMiddleware("dispatch_work"), async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ ok: false, error: "Body must be an object" }, 400);
  const env = c.env as Env;
  const request = body as { taskId?: unknown; attempts?: unknown; decision?: unknown; candidateIndex?: unknown; result?: unknown };
  if (typeof request.taskId !== "string" || !Number.isSafeInteger(request.attempts) || !["apply", "keep", "retry"].includes(String(request.decision))) {
    return c.json({ ok: false, error: "Invalid review request" }, 400);
  }
  const row = await env.DB.prepare(
    "SELECT payload, result_json, max_attempts FROM work_queue WHERE id = ? AND task_type = 'scrape' AND status = 'completed' AND attempts = ? AND error_message = ?",
  ).bind(request.taskId, request.attempts, RETRIEVAL_REVIEW_PENDING).first<{ payload: string; result_json: string | null; max_attempts: number }>();
  if (!row) return c.json({ ok: false, error: "Review task changed or is no longer pending" }, 409);
  let payload: Record<string, unknown>;
  let prior: Record<string, unknown>;
  try { payload = JSON.parse(row.payload); prior = JSON.parse(row.result_json || "{}"); }
  catch { return c.json({ ok: false, error: "Stored review task is invalid" }, 409); }
  if (request.decision === "keep") {
    const kept = await env.DB.prepare(
      "UPDATE work_queue SET error_message = ? WHERE id = ? AND status = 'completed' AND attempts = ? AND error_message = ?",
    ).bind(RETRIEVAL_REVIEW_KEPT, request.taskId, request.attempts, RETRIEVAL_REVIEW_PENDING).run();
    return kept.meta.changes === 1 ? c.json({ ok: true, decision: "keep" }) : c.json({ ok: false, error: "Review task changed" }, 409);
  }
  if (request.decision === "retry") {
    const refreshedPayload = await refreshRetrievalPayload(env, payload);
    if (!refreshedPayload) return c.json({ ok: false, error: "Track source or identity is no longer available for retry" }, 409);
    const retried = await env.DB.prepare(
      `UPDATE work_queue SET status = 'queued', payload = ?, max_attempts = attempts + ?, error_message = NULL,
         claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, result_json = NULL, expires_at = NULL
       WHERE id = ? AND status = 'completed' AND attempts = ? AND error_message = ?`,
    ).bind(JSON.stringify(refreshedPayload), RETRIEVAL_RETRY_BUDGET, request.taskId, request.attempts, RETRIEVAL_REVIEW_PENDING).run();
    if (retried.meta.changes !== 1) return c.json({ ok: false, error: "Review task changed" }, 409);
    try { await notifyCoordinator(env); } catch (error) { console.error("[work] coordinator notify failed:", error); }
    return c.json({ ok: true, decision: "retry" });
  }
  if (!Number.isSafeInteger(request.candidateIndex) || !Array.isArray(prior.candidates) ||
      Number(request.candidateIndex) < 0 || Number(request.candidateIndex) >= prior.candidates.length) {
    return c.json({ ok: false, error: "candidateIndex does not identify a saved candidate" }, 400);
  }
  const selected = prior.candidates[Number(request.candidateIndex)] as Record<string, unknown>;
  const resolved = request.result as Record<string, unknown> | null;
  const match = resolved && typeof resolved === "object" ? resolved.match as Record<string, unknown> | undefined : undefined;
  if (!resolved || "manualReview" in resolved || resolved.kind !== "metadata-retrieval" || resolved.status !== "matched" ||
      resolved.masterId !== payload.masterId || resolved.instanceId !== payload.instanceId ||
      !match || match.source !== selected.source || match.songId !== selected.songId ||
      !isMetadataIdentityRecord(payload.identity) || !isMetadataIdentityRecord(payload.snapshot) ||
      !isSelectableMetadataMatch(match, { identity: payload.identity, snapshot: payload.snapshot })) {
    return c.json({ ok: false, error: "Resolved candidate does not match the saved selection and known metadata" }, 400);
  }
  for (const field of ["title", "artist", "album"] as const) {
    if (isKnownMetadataIdentity(selected[field]) &&
        (!isKnownMetadataIdentity(match[field]) || normalizeMetadataIdentity(selected[field]) !== normalizeMetadataIdentity(match[field]))) {
      return c.json({ ok: false, error: `Resolved ${field} differs from the saved candidate` }, 400);
    }
  }
  const approvedResult = { ...resolved, manualReview: { candidateIndex: Number(request.candidateIndex), pendingResult: prior } };
  const resolvedJson = JSON.stringify(approvedResult);
  if (resolvedJson.length > 500_000) return c.json({ ok: false, error: "Resolved result is too large" }, 413);
  const applying = await env.DB.prepare(
    `UPDATE work_queue SET result_json = ?, error_message = ?
     WHERE id = ? AND status = 'completed' AND attempts = ? AND error_message = ?`,
  ).bind(resolvedJson, RETRIEVAL_APPLY_PENDING, request.taskId, request.attempts, RETRIEVAL_REVIEW_PENDING).run();
  if (applying.meta.changes !== 1) return c.json({ ok: false, error: "Review task changed" }, 409);
  const applied = await applyCompletedRetrieval(env, request.taskId, row.payload, approvedResult, true);
  return applied.ok ? c.json({ ok: true, decision: "apply", applied }) : c.json({ ok: false, error: applied.reason || "Unable to apply metadata" }, 409);
});

export function isMetadataRetrievalPayload(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "metadata-retrieval";
}

export function isValidMetadataRetrievalResult(payload: Record<string, unknown>, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if ("manualReview" in value) return false;
  const result = value as RetrievalResult;
  if (result.kind !== "metadata-retrieval" || result.masterId !== payload.masterId ||
      result.instanceId !== payload.instanceId) return false;
  if (result.status === "pending") {
    if (!Array.isArray(result.candidates) || result.candidates.length > 10 ||
        !["ambiguous", "no-credible-match"].includes(String(result.reason))) return false;
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    return result.candidates.every((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const item = candidate as Record<string, unknown>;
      return typeof item.source === "string" && sources.includes(item.source) &&
        typeof item.songId === "string" && !!item.songId.trim() &&
        typeof item.title === "string" && !!item.title.trim() &&
        typeof item.artist === "string" &&
        (item.album === undefined || typeof item.album === "string") &&
        (item.albumArtist === undefined || typeof item.albumArtist === "string") &&
        (item.year === undefined || (Number.isInteger(item.year) && Number(item.year) > 0)) &&
        (item.lyrics === undefined || typeof item.lyrics === "string") &&
        isMetadataIdentityRecord(payload.identity) && isMetadataIdentityRecord(payload.snapshot) &&
        isSelectableMetadataMatch(item, { identity: payload.identity, snapshot: payload.snapshot });
    });
  }
  if (result.status !== "matched" || !result.match || typeof result.match !== "object" || Array.isArray(result.match)) return false;
  const match = result.match as Record<string, unknown>;
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const identity = isMetadataIdentityRecord(payload.identity) ? payload.identity : undefined;
  const snapshot = isMetadataIdentityRecord(payload.snapshot) ? payload.snapshot : undefined;
  const albumKnown = isKnownMetadataIdentity(identity?.album) || isKnownMetadataIdentity(snapshot?.album);
  return !!identity && !!snapshot &&
    typeof match.source === "string" && sources.includes(match.source) &&
    typeof match.songId === "string" && !!match.songId.trim() &&
    typeof match.title === "string" && !!match.title.trim() &&
    typeof match.artist === "string" && !!match.artist.trim() &&
    (!albumKnown || (typeof match.album === "string" && !!match.album.trim())) &&
    (match.album === undefined || (typeof match.album === "string" && !!match.album.trim())) &&
    isCredibleMetadataMatch(match, identity) && matchesKnownSnapshot(match, snapshot);
}

interface RetrievalResult {
  kind?: unknown; masterId?: unknown; instanceId?: unknown; status?: unknown;
  reason?: unknown; match?: unknown; cover?: unknown; candidates?: unknown;
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
  env: Env, taskId: string, payloadJson: string, result: unknown, manuallyReviewed = false,
): Promise<ApplyAnnotation> {
  const manualReview = result && typeof result === "object" && !Array.isArray(result)
    ? (result as { manualReview?: { pendingResult?: unknown } }).manualReview
    : undefined;
  manuallyReviewed = manuallyReviewed || !!manualReview;
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
  let refreshedPayloadJson: string | null = null;
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const r = result as RetrievalResult | null;
    const snapshot = payload.snapshot as RetrievalSnapshot | undefined;
    if (!snapshot || payload.kind !== "metadata-retrieval" || !r || r.kind !== "metadata-retrieval" ||
        r.masterId !== payload.masterId || r.instanceId !== payload.instanceId ||
        typeof r.masterId !== "string" || typeof r.instanceId !== "string") {
      annotation = { ok: false, reason: "task result identity mismatch" };
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
      const pathState = current
        ? await retrieveSourcePathState(env.DB, String(payload.instanceId))
        : { count: 0, uniquePath: null };
      const currentAlbumFolder = pathState.uniquePath ? albumNameFromSourcePath(pathState.uniquePath) : null;
      const folderChanged = metadataMissing(snapshot.album, "album") &&
        (snapshot.albumFolder ?? null) !== currentAlbumFolder;
      const fieldsCurrent = current && current.title === snapshot.title && current.artist_name === snapshot.artist &&
        current.album_name === snapshot.album && current.album_artist_name === snapshot.albumArtist &&
        current.year === snapshot.year && current.lyrics === snapshot.lyrics &&
        current.updated_at === snapshot.masterUpdatedAt &&
        (current.song_cover_r2_key || current.album_cover_r2_key) === snapshot.coverR2Key;
      if (!current || current.storage_uri !== payload.sourceUri || current.source_etag !== (payload.sourceEtag ?? null) ||
          current.missing !== 0 || current.source_type !== "original" || !fieldsCurrent || folderChanged) {
        annotation = { ok: false, reason: "source or metadata changed since retrieval was queued" };
        if (manuallyReviewed) {
          retry = true;
          if (current && current.missing === 0 && current.source_type === "original") {
            const hints = await retrieveCurrentHints(env.DB, String(payload.instanceId), {
              title: current.title, artist: current.artist_name, album: current.album_name,
              albumArtist: current.album_artist_name,
            });
            const refreshed = {
              ...payload,
              sourceUri: current.storage_uri,
              sourceEtag: current.source_etag,
              identity: hints.identity,
              query: hints.query,
              snapshot: {
                ...snapshot,
                title: current.title, artist: current.artist_name, album: current.album_name,
                albumArtist: current.album_artist_name, year: current.year, lyrics: current.lyrics,
                coverR2Key: current.song_cover_r2_key || current.album_cover_r2_key,
                masterUpdatedAt: current.updated_at, albumFolder: hints.albumFolder,
              },
            };
            refreshedPayloadJson = JSON.stringify(refreshed);
          }
        }
      } else if (typeof match.source !== "string" || !sourceList.includes(match.source) ||
          typeof match.songId !== "string" || !match.songId.trim() ||
          !payload.identity || typeof payload.identity !== "object" || Array.isArray(payload.identity) ||
          (manuallyReviewed
            ? !isSelectableMetadataMatch(match, { identity: payload.identity, snapshot })
            : !isCredibleMetadataMatch(match, payload.identity as { title?: unknown; artist?: unknown; album?: unknown }) || !matchesKnownSnapshot(match, snapshot))) {
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
               AND storage_uri = ? AND source_etag IS ? AND missing = 0 AND source_type = 'original')
             AND (SELECT COUNT(*) FROM storage_entries WHERE instance_id = ? AND kind = 'file') = ?
             AND (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(path) ELSE NULL END FROM storage_entries
               WHERE instance_id = ? AND kind = 'file') IS ?`,
        ).bind(
          title, titleMissing ? title.toLowerCase() : current.sort_title, primaryArtist?.id ?? current.artist_id,
          albumArtistCredit?.id ?? current.album_artist_id, albumId,
          lyricsMissing ? (match.lyrics as string).trim() : current.lyrics,
          now, current.id, current.album_id, current.title, current.lyrics, current.artist_id,
          current.album_artist_id, snapshot.masterUpdatedAt, taskId, applying, current.artist_name, current.album_artist_name, current.song_cover_r2_key || "",
          current.album_id, current.album_name, current.year,
          current.album_cover_r2_key || "", payload.instanceId, current.id, payload.sourceUri,
          payload.sourceEtag ?? null, payload.instanceId, pathState.count, payload.instanceId, pathState.uniquePath,
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
          if (manuallyReviewed) {
            const refreshed = await refreshRetrievalPayload(env, payload);
            if (refreshed) refreshedPayloadJson = JSON.stringify(refreshed);
          }
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
    `UPDATE work_queue SET error_message = ?, result_json = CASE WHEN ? IS NULL THEN result_json ELSE ? END,
       payload = COALESCE(?, payload) WHERE id = ? AND status = 'completed'
      AND (error_message = ? OR (? IS NOT NULL AND error_message = ?))`,
  ).bind(retry ? (manuallyReviewed ? RETRIEVAL_REVIEW_PENDING : RETRIEVAL_APPLY_PENDING) : null,
    manuallyReviewed && retry ? JSON.stringify(manualReview?.pendingResult ?? null) : null,
    manuallyReviewed && retry ? JSON.stringify(manualReview?.pendingResult ?? null) : null,
    refreshedPayloadJson, taskId, applying, completedReceipt ? 1 : null,
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
    try {
      const savedManualReview = !!(result && typeof result === "object" && !Array.isArray(result) &&
        (result as { manualReview?: unknown }).manualReview);
      await applyCompletedRetrieval(env, row.id, row.payload, result, savedManualReview);
    }
    catch (error) { console.error(`[work/recover] retrieval apply failed for ${row.id}:`, error); }
  }
  return rows.length;
}
