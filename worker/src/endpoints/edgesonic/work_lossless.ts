import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import type { User } from "../../types/entities";
import { verifyUploadToken } from "../../utils/workUploadToken";
import { r2KeyFromUri } from "../../utils/storageResolver";
import {
  enqueueLosslessBatch,
  loadCurrentLosslessClaim,
  losslessOutputObject,
  openLosslessSource,
  sha256Stream,
  toHex,
  type LosslessPayload,
} from "../../utils/losslessCompression";
import { wakePool } from "./work";

export const workLosslessRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

workLosslessRoutes.post("/work/lossless/dispatch", permissionMiddleware("dispatch_work"), async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return c.json({ ok: false, error: "Expected an empty JSON object" }, 400);
  }
  const result = await enqueueLosslessBatch(c.env as Env);
  if (result.enqueued > 0) await wakePool(c.env as Env);
  return c.json({ ok: true, ...result });
});

workLosslessRoutes.get("/work/lossless/source", async (c) => {
  const identity = await readClaimIdentity(c.req.query(), c.env as Env);
  if (!identity.ok) return c.json({ ok: false, error: identity.error }, identity.status);
  const user = c.get("user");
  const claim = await loadCurrentLosslessClaim(c.env as Env, identity.id, user.username,
    identity.attempts, identity.claimedAt);
  if (!claim || claim.status !== "claimed") return c.json({ ok: false, error: "Claim is no longer active" }, 409);
  const payload = parsePayload(claim.payload);
  if (!payload) return c.json({ ok: false, error: "Corrupt task payload" }, 500);
  if (!await sourceSnapshotMatches(c.env as Env, payload)) {
    return c.json({ ok: false, error: "Source snapshot changed" }, 409);
  }
  const source = await openLosslessSource(c.env as Env, payload);
  if (!source) return c.json({ ok: false, error: "Source object changed or is unavailable" }, 409);
  return new Response(source.body, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(source.size),
      "Cache-Control": "no-store",
    },
  });
});

workLosslessRoutes.post("/work/lossless/upload", async (c) => {
  const env = c.env as Env;
  const identity = await readClaimIdentity(c.req.query(), env);
  if (!identity.ok) return c.json({ ok: false, error: identity.error }, identity.status);
  if (c.req.header("X-Work-Attempt") !== String(identity.attempts)
    || c.req.header("X-Work-Claimed-At") !== String(identity.claimedAt)) {
    return c.json({ ok: false, error: "Upload claim headers do not match the signed claim" }, 409);
  }
  const user = c.get("user");
  const claim = await loadCurrentLosslessClaim(env, identity.id, user.username,
    identity.attempts, identity.claimedAt);
  if (!claim) return c.json({ ok: false, error: "Claim is no longer available" }, 409);
  const outputSha = headerHex(c.req.header("X-Output-SHA256"));
  if (claim.status === "completed") {
    const receipt = parseReceipt(claim.result_json);
    if (receipt?.serverVerified === "lossless" && receipt.outputSha256 === outputSha) {
      return c.json({ ok: true, status: "completed", registered: true, replayed: true,
        r2Key: receipt.r2Key, size: receipt.size, instanceId: receipt.instanceId });
    }
    return c.json({ ok: false, error: "Completed task receipt does not match upload" }, 409);
  }
  if (claim.status !== "claimed") return c.json({ ok: false, error: "Claim is no longer active" }, 409);

  const payload = parsePayload(claim.payload);
  if (!payload) return c.json({ ok: false, error: "Corrupt task payload" }, 500);
  const evidence = parseVerification(c.req.header("X-Verification-JSON"));
  const sourceSha = headerHex(c.req.header("X-Source-SHA256"));
  const sourcePcmSha = headerHex(c.req.header("X-Source-PCM-SHA256"));
  const outputPcmSha = headerHex(c.req.header("X-Output-PCM-SHA256"));
  if (!evidence || !sourceSha || !outputSha || !sourcePcmSha || !outputPcmSha
    || sourcePcmSha !== outputPcmSha || evidence.sourceBytes !== payload.sourceSize
    || evidence.outputBytes >= evidence.sourceBytes || !evidence.metadataPreserved) {
    return c.json({ ok: false, error: "Invalid lossless verification evidence" }, 422);
  }
  if (c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !== "audio/flac") {
    return c.json({ ok: false, error: "Expected audio/flac" }, 415);
  }
  const declaredLength = Number(c.req.header("Content-Length") || 0);
  if (declaredLength > MAX_UPLOAD_BYTES || declaredLength > 0 && declaredLength !== evidence.outputBytes) {
    return c.json({ ok: false, error: "Invalid output size" }, 413);
  }
  if (evidence.outputBytes > MAX_UPLOAD_BYTES || evidence.outputBytes <= 0) {
    return c.json({ ok: false, error: "Output size is outside the upload limit" }, 413);
  }
  if (!await sourceSnapshotMatches(env, payload)) {
    return c.json({ ok: false, error: "Source snapshot changed" }, 409);
  }
  const source = await openLosslessSource(env, payload);
  if (!source) return c.json({ ok: false, error: "Source object changed or is unavailable" }, 409);
  const actualSourceSha = await sha256Stream(source.body);
  if (actualSourceSha !== sourceSha) return c.json({ ok: false, error: "Source digest mismatch" }, 422);

  if (!c.req.raw.body) return c.json({ ok: false, error: "Missing FLAC body" }, 400);
  const bodySize = { value: 0 };
  const bounded = c.req.raw.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bodySize.value += chunk.byteLength;
      if (bodySize.value > MAX_UPLOAD_BYTES) {
        controller.error(new Error("Output exceeds upload limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  const reader = bounded.getReader();
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  try {
    while (prefixBytes < 42) {
      const next = await reader.read();
      if (next.done) break;
      prefix.push(next.value);
      prefixBytes += next.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => {});
    return c.json({ ok: false, error: "Unable to read FLAC header" }, 422);
  }
  const flacHeader = prefixBytes >= 42 ? concatPrefix(prefix, 42) : null;
  if (!flacHeader || !validFlacStreamInfo(flacHeader, evidence)) {
    await reader.cancel("invalid FLAC header").catch(() => {});
    return c.json({ ok: false, error: "Invalid FLAC STREAMINFO" }, 422);
  }

  const { objectId, key } = losslessOutputObject(payload.instanceId, outputSha, crypto.randomUUID());
  const digest = new crypto.DigestStream("SHA-256");
  const digestWriter = digest.getWriter();
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(concatPrefix(prefix, prefixBytes));
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  }).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await digestWriter.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() { await digestWriter.close(); },
  })).pipeThrough(new FixedLengthStream(evidence.outputBytes));
  let written: R2Object;
  try {
    written = await env.MUSIC_BUCKET.put(key, replay, { httpMetadata: { contentType: "audio/flac" } });
  } catch {
    await cleanupLosslessOutput(env, objectId, key);
    return c.json({ ok: false, error: "Unable to store verified FLAC output" }, 502);
  }
  const actualOutputSha = toHex(await digest.digest);
  if (bodySize.value !== evidence.outputBytes || written.size !== evidence.outputBytes
    || actualOutputSha !== outputSha || written.size >= payload.sourceSize) {
    await cleanupLosslessOutput(env, objectId, key);
    return c.json({ ok: false, error: "FLAC body does not match its verification evidence" }, 422);
  }
  try {
    const registered = await env.DB.prepare(
      `INSERT INTO storage_objects
         (id, physical_key, suffix, content_type, size, etag, created_at, updated_at)
       VALUES (?, ?, 'flac', 'audio/flac', ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(id) DO NOTHING`,
    ).bind(objectId, key, written.size, written.etag).run();
    if (registered.meta.changes !== 1) throw new Error("Output object identity already exists");
  } catch {
    await cleanupLosslessOutput(env, objectId, key);
    return c.json({ ok: false, error: "Unable to register verified FLAC output" }, 500);
  }

  let applied: boolean;
  try {
    applied = await switchCatalogToFlac(env, claim, payload, {
      objectId, key, size: written.size, etag: written.etag,
      outputSha256: actualOutputSha, sourceSha256: actualSourceSha,
      pcmSha256: sourcePcmSha, evidence,
    });
  } catch {
    await cleanupLosslessOutput(env, objectId, key);
    return c.json({ ok: false, error: "Catalog replacement failed; source remains available" }, 500);
  }
  if (!applied) {
    await cleanupLosslessOutput(env, objectId, key);
    return c.json({ ok: false, error: "Claim or catalog source changed before replacement" }, 409);
  }
  try { await retireOldObject(env, payload.sourceObjectId, payload.sourceUri); }
  catch { /* the catalog is already switched; an unreferenced source can be retired later */ }
  return c.json({ ok: true, status: "completed", registered: true, r2Key: key,
    instanceId: payload.instanceId, size: written.size });
});

async function readClaimIdentity(
  query: Record<string, string>,
  env: Env,
): Promise<{ ok: true; id: string; attempts: number; claimedAt: number } | { ok: false; status: 400 | 401; error: string }> {
  const id = query.id || "";
  const token = query.token || "";
  const attempts = Number(query.attempts);
  const claimedAt = Number(query.claimedAt);
  if (!id || !token || !Number.isSafeInteger(attempts) || !Number.isSafeInteger(claimedAt)) {
    return { ok: false, status: 400, error: "Missing claim identity" };
  }
  if (!(await verifyUploadToken(env, id, token)).ok) {
    return { ok: false, status: 401, error: "Invalid or expired token" };
  }
  return { ok: true, id, attempts, claimedAt };
}

function parsePayload(raw: string): LosslessPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<LosslessPayload>;
    if (typeof value.sourceUri !== "string" || typeof value.instanceId !== "string"
      || typeof value.sourceObjectId !== "string" || typeof value.sourceEtag !== "string"
      || !Number.isSafeInteger(value.sourceSize) || (value.sourceSize ?? 0) <= 0) return null;
    return value as LosslessPayload;
  } catch { return null; }
}

async function sourceSnapshotMatches(env: Env, payload: LosslessPayload): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT si.storage_uri, si.storage_object_id, si.suffix, si.source_type, si.missing,
            o.size, o.etag, o.physical_key, o.suffix AS object_suffix
       FROM song_instances si
       JOIN storage_objects o ON o.id = si.storage_object_id
      WHERE si.id = ?`,
  ).bind(payload.instanceId).first<{
    storage_uri: string; storage_object_id: string; suffix: string; source_type: string;
    missing: number; size: number; etag: string; physical_key: string; object_suffix: string;
  }>();
  const matches = !!row && row.source_type === "original" && row.missing === 0
    && row.suffix.toLowerCase() === "wav" && row.object_suffix.toLowerCase() === "wav"
    && row.storage_uri === payload.sourceUri && row.storage_object_id === payload.sourceObjectId
    && row.size === payload.sourceSize && row.etag === payload.sourceEtag
    && payload.sourceUri === `r2://${row.physical_key}`;
  if (!matches) return false;
  let key: string;
  try { key = r2KeyFromUri(payload.sourceUri); } catch { return false; }
  const head = await env.MUSIC_BUCKET.head(key);
  return !!head && head.size === payload.sourceSize && head.etag === payload.sourceEtag;
}

interface VerificationEvidence {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  sourceBytes: number;
  outputBytes: number;
  metadataPreserved: true;
}

function parseVerification(raw: string | undefined): VerificationEvidence | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const value = JSON.parse(raw) as Partial<VerificationEvidence>;
    if (!Number.isSafeInteger(value.sampleRate) || (value.sampleRate ?? 0) <= 0
      || !Number.isSafeInteger(value.channels) || (value.channels ?? 0) < 1 || (value.channels ?? 0) > 8
      || !Number.isSafeInteger(value.bitsPerSample) || (value.bitsPerSample ?? 0) < 4 || (value.bitsPerSample ?? 0) > 32
      || !Number.isSafeInteger(value.sourceBytes) || (value.sourceBytes ?? 0) <= 0
      || !Number.isSafeInteger(value.outputBytes) || (value.outputBytes ?? 0) <= 0
      || value.metadataPreserved !== true) return null;
    return value as VerificationEvidence;
  } catch { return null; }
}

function headerHex(value: string | undefined): string | null {
  return value && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function concatPrefix(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.byteLength, length - offset);
    result.set(chunk.subarray(0, count), offset);
    offset += count;
    if (offset === length) break;
  }
  return result;
}

function validFlacStreamInfo(header: Uint8Array, evidence: VerificationEvidence): boolean {
  if (String.fromCharCode(...header.subarray(0, 4)) !== "fLaC"
    || header[4] !== 0 || header[5] !== 0 || header[6] !== 0 || header[7] !== 34) return false;
  const packed = (BigInt(header[18]) << 56n) | (BigInt(header[19]) << 48n)
    | (BigInt(header[20]) << 40n) | (BigInt(header[21]) << 32n)
    | (BigInt(header[22]) << 24n) | (BigInt(header[23]) << 16n)
    | (BigInt(header[24]) << 8n) | BigInt(header[25]);
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const bitsPerSample = Number((packed >> 36n) & 0x1fn) + 1;
  const totalSamples = packed & 0xfffffffffn;
  return sampleRate === evidence.sampleRate && channels === evidence.channels
    && bitsPerSample === evidence.bitsPerSample && totalSamples > 0n;
}

async function switchCatalogToFlac(
  env: Env,
  claim: { id: string; claimed_by: string | null; attempts: number; claimed_at: number | null },
  payload: LosslessPayload,
  output: { objectId: string; key: string; size: number; etag: string; outputSha256: string; sourceSha256: string; pcmSha256: string; evidence: VerificationEvidence },
): Promise<boolean> {
  if (!claim.claimed_by || claim.claimed_at === null) return false;
  if (!await sourceSnapshotMatches(env, payload)) return false;
  const receipt = JSON.stringify({
    serverVerified: "lossless", instanceId: payload.instanceId,
    sourceObjectId: payload.sourceObjectId, outputObjectId: output.objectId,
    outputSha256: output.outputSha256, sourceSha256: output.sourceSha256,
    pcmSha256: output.pcmSha256, size: output.size, r2Key: output.key,
  });
  const newUri = `r2://${output.key}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE song_instances
          SET storage_uri = ?, storage_object_id = ?, suffix = 'flac', content_type = 'audio/flac',
              size = ?, sample_rate = ?, channels = ?, bit_depth = ?,
              bit_rate = CASE WHEN duration > 0 THEN CAST((? * 8.0 / duration / 1000) AS INTEGER) ELSE bit_rate END,
              source_etag = ?, source_last_modified = unixepoch(),
              updated_at = unixepoch()
        WHERE id = ? AND source_type = 'original' AND missing = 0
          AND storage_uri = ? AND storage_object_id = ? AND lower(suffix) = 'wav'
          AND EXISTS (SELECT 1 FROM storage_objects WHERE id = ? AND physical_key = ?
            AND size = ? AND etag = ? AND suffix = 'flac')
          AND EXISTS (SELECT 1 FROM storage_objects WHERE id = ? AND physical_key = ?
            AND size = ? AND etag = ? AND lower(suffix) = 'wav')
          AND EXISTS (SELECT 1 FROM work_queue WHERE id = ? AND task_type = 'lossless'
            AND status = 'claimed' AND claimed_by = ? AND attempts = ? AND claimed_at = ?)`,
    ).bind(newUri, output.objectId, output.size, output.evidence.sampleRate,
      output.evidence.channels, output.evidence.bitsPerSample, output.size, output.etag, payload.instanceId,
      payload.sourceUri, payload.sourceObjectId, output.objectId, output.key,
      output.size, output.etag, payload.sourceObjectId, payload.sourceUri.slice("r2://".length),
      payload.sourceSize, payload.sourceEtag,
      claim.id, claim.claimed_by, claim.attempts, claim.claimed_at),
    env.DB.prepare(
      `UPDATE storage_entries
          SET object_id = ?,
              path = CASE WHEN lower(path) LIKE '%.wav' THEN substr(path, 1, length(path) - 3) || 'flac' ELSE path END,
              display_name = CASE WHEN lower(display_name) LIKE '%.wav' THEN substr(display_name, 1, length(display_name) - 3) || 'flac' ELSE display_name END,
              updated_at = unixepoch()
        WHERE instance_id = ? AND object_id = ? AND source_id = 'r2-local' AND kind = 'file'
          AND EXISTS (SELECT 1 FROM song_instances WHERE id = ? AND storage_uri = ? AND storage_object_id = ?)`,
    ).bind(output.objectId, payload.instanceId, payload.sourceObjectId,
      payload.instanceId, newUri, output.objectId),
    env.DB.prepare(
      `UPDATE work_queue SET status = 'completed', result_json = ?, error_message = NULL,
             heartbeat_at = unixepoch()
        WHERE id = ? AND task_type = 'lossless' AND status = 'claimed'
          AND claimed_by = ? AND attempts = ? AND claimed_at = ?
          AND EXISTS (SELECT 1 FROM song_instances WHERE id = ? AND storage_uri = ? AND storage_object_id = ?)
          AND EXISTS (SELECT 1 FROM storage_objects WHERE id = ? AND physical_key = ?)`,
    ).bind(receipt, claim.id, claim.claimed_by, claim.attempts, claim.claimed_at,
      payload.instanceId, newUri, output.objectId, output.objectId, output.key),
  ]);
  return results[2].meta.changes === 1;
}

async function cleanupLosslessOutput(env: Env, objectId: string, key: string): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT id, physical_key FROM storage_objects WHERE id = ? OR physical_key = ? LIMIT 1",
  ).bind(objectId, key).first<{ id: string; physical_key: string }>();
  if (existing) {
    if (existing.id === objectId && existing.physical_key === key) {
      await deleteUnreferencedObject(env, objectId, key);
    }
    return;
  }
  const referenced = await env.DB.prepare(
    `SELECT 1 AS used WHERE EXISTS (
       SELECT 1 FROM song_instances WHERE storage_object_id = ? OR storage_uri = ?
     ) OR EXISTS (SELECT 1 FROM storage_entries WHERE object_id = ?)`,
  ).bind(objectId, `r2://${key}`, objectId).first<{ used: number }>();
  if (!referenced) await env.MUSIC_BUCKET.delete(key).catch(() => {});
}

async function deleteUnreferencedObject(env: Env, objectId: string, key: string): Promise<void> {
  const removed = await env.DB.prepare(
    `DELETE FROM storage_objects WHERE id = ? AND NOT EXISTS (
       SELECT 1 FROM song_instances WHERE storage_object_id = storage_objects.id OR storage_uri = 'r2://' || storage_objects.physical_key
     ) AND NOT EXISTS (SELECT 1 FROM storage_entries WHERE object_id = storage_objects.id)
       AND physical_key = ?`,
  ).bind(objectId, key).run();
  if (removed.meta.changes === 1) await env.MUSIC_BUCKET.delete(key).catch(() => {});
}

async function retireOldObject(env: Env, objectId: string, sourceUri: string): Promise<void> {
  const key = sourceUri.slice("r2://".length);
  const removed = await env.DB.prepare(
    `DELETE FROM storage_objects WHERE id = ? AND NOT EXISTS (
       SELECT 1 FROM song_instances WHERE storage_object_id = storage_objects.id OR storage_uri = 'r2://' || storage_objects.physical_key
     ) AND NOT EXISTS (
       SELECT 1 FROM storage_entries WHERE object_id = storage_objects.id
     )`,
  ).bind(objectId).run();
  if (removed.meta.changes === 1) await env.MUSIC_BUCKET.delete(key);
}

function parseReceipt(raw: string | null): { serverVerified?: string; outputSha256?: string; instanceId?: string; r2Key?: string; size?: number } | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as { serverVerified?: string; outputSha256?: string; instanceId?: string; r2Key?: string; size?: number }; }
  catch { return null; }
}
