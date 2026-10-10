import { createStableObjectId, createStableObjectKey } from "./storageObjects";
import { r2KeyFromUri } from "./storageResolver";

export interface LosslessPayload {
  sourceUri: string;
  instanceId: string;
  sourceSize: number;
  sourceEtag: string;
  sourceObjectId: string;
  streamUrl?: string;
  uploadUrl?: string;
}

export interface LosslessClaim {
  id: string;
  status: string;
  claimed_by: string | null;
  attempts: number;
  claimed_at: number | null;
  payload: string;
  result_json: string | null;
  task_type: string;
}

export async function enqueueLosslessBatch(env: Env): Promise<{ enqueued: number; skipped: number }> {
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM song_instances si
       JOIN storage_objects o ON o.id = si.storage_object_id
      WHERE si.source_type = 'original' AND si.missing = 0
        AND lower(si.suffix) = 'wav' AND si.storage_uri = 'r2://' || o.physical_key
        AND lower(o.suffix) = 'wav' AND o.size > 0 AND o.etag IS NOT NULL`,
  ).first<{ count: number }>();
  const candidates = (await env.DB.prepare(
    `SELECT si.id AS instance_id, si.storage_uri AS source_uri,
            si.storage_object_id AS source_object_id, o.size AS source_size,
            o.etag AS source_etag
       FROM song_instances si
       JOIN storage_objects o ON o.id = si.storage_object_id
      WHERE si.source_type = 'original' AND si.missing = 0
        AND lower(si.suffix) = 'wav' AND si.storage_uri = 'r2://' || o.physical_key
        AND lower(o.suffix) = 'wav' AND o.size > 0 AND o.etag IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM work_queue q
           WHERE q.id = 'wt-lossless-' || si.id AND q.status IN ('queued', 'claimed')
        )
      ORDER BY si.created_at ASC, si.id ASC
      LIMIT ?`,
  ).bind(LOSSLESS_BATCH_LIMIT).all<{
    instance_id: string;
    source_uri: string;
    source_object_id: string;
    source_size: number;
    source_etag: string;
  }>()).results;
  const statements = candidates.map((source) => {
    const id = `wt-lossless-${source.instance_id}`;
    const payload: LosslessPayload = {
      sourceUri: source.source_uri,
      instanceId: source.instance_id,
      sourceSize: source.source_size,
      sourceEtag: source.source_etag,
      sourceObjectId: source.source_object_id,
    };
    return env.DB.prepare(
      `INSERT INTO work_queue
         (id, task_type, payload, required_caps, priority, status, max_attempts)
       VALUES (?, 'lossless', ?, '["ffmpeg"]', 5, 'queued', 3)
       ON CONFLICT(id) DO UPDATE SET
         task_type = 'lossless', payload = excluded.payload,
         required_caps = excluded.required_caps, priority = excluded.priority,
         status = 'queued', attempts = 0, max_attempts = excluded.max_attempts,
         error_message = NULL, claimed_by = NULL, claimed_at = NULL,
         heartbeat_at = NULL, result_json = NULL
       WHERE work_queue.status IN ('failed', 'canceled')`,
    ).bind(id, JSON.stringify(payload));
  });
  let enqueued = 0;
  for (let offset = 0; offset < statements.length; offset += 80) {
    const results = await env.DB.batch(statements.slice(offset, offset + 80));
    for (const result of results) enqueued += result.meta.changes ?? 0;
  }
  return { enqueued, skipped: Math.max(0, (total?.count ?? 0) - enqueued) };
}

export async function loadCurrentLosslessClaim(
  env: Env,
  id: string,
  username: string,
  attempts: number,
  claimedAt: number,
): Promise<LosslessClaim | null> {
  return env.DB.prepare(
    `SELECT id, task_type, status, claimed_by, attempts, claimed_at, payload, result_json
       FROM work_queue WHERE id = ? AND task_type = 'lossless'
         AND status IN ('claimed', 'completed') AND claimed_by = ?
         AND attempts = ? AND claimed_at = ?`,
  ).bind(id, username, attempts, claimedAt).first<LosslessClaim>();
}

export async function openLosslessSource(
  env: Env,
  payload: LosslessPayload,
): Promise<{ body: ReadableStream<Uint8Array>; etag: string; size: number } | null> {
  let key: string;
  try { key = r2KeyFromUri(payload.sourceUri); } catch { return null; }
  const head = await env.MUSIC_BUCKET.head(key);
  if (!head || head.size !== payload.sourceSize || head.etag !== payload.sourceEtag) return null;
  const object = await env.MUSIC_BUCKET.get(key);
  if (!object?.body || object.etag !== payload.sourceEtag || object.size !== payload.sourceSize) return null;
  return { body: object.body, etag: head.etag, size: head.size };
}

export async function sha256Stream(body: ReadableStream<Uint8Array>): Promise<string> {
  const digest = new crypto.DigestStream("SHA-256");
  await body.pipeTo(digest);
  return toHex(await digest.digest);
}

export function losslessOutputObject(instanceId: string, outputSha256: string, uploadNonce: string): { objectId: string; key: string } {
  const objectId = createStableObjectId(`lossless:${instanceId}:${outputSha256}:${uploadNonce}`);
  return { objectId, key: createStableObjectKey(objectId, "flac") };
}

export const LOSSLESS_BATCH_LIMIT = 100;
export const LOSSLESS_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
