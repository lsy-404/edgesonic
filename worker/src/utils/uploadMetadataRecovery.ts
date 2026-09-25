// SPDX-License-Identifier: AGPL-3.0-or-later

import { enqueueUploadMetadata, recoverStaleUploadMetadataLeases, uploadMetadataMarkerId } from "./uploadMetadataQueue";

const MIN_UPLOAD_AGE_SECONDS = 10 * 60;
const RECOVERY_BATCH_SIZE = 50;

export async function recoverPendingUploadMetadata(env: Env): Promise<number> {
  await recoverStaleUploadMetadataLeases(env.DB);
  const cutoff = Math.floor(Date.now() / 1000) - MIN_UPLOAD_AGE_SECONDS;
  const markers = (await env.DB.prepare(
    `SELECT id, payload, created_at
       FROM work_queue
      WHERE task_type = 'manual_upload_pending'
        AND status = 'canceled'
        AND created_at <= ?
      ORDER BY created_at ASC
      LIMIT ${RECOVERY_BATCH_SIZE}`,
  ).bind(cutoff).all<{ id: string; payload: string; created_at: number }>()).results;

  let queued = 0;
  for (const marker of markers) {
    let payload: { instanceId?: unknown; storageUri?: unknown; uploadNonce?: unknown };
    try { payload = JSON.parse(marker.payload) as { instanceId?: unknown; storageUri?: unknown }; }
    catch {
      await env.DB.prepare(
        "DELETE FROM work_queue WHERE id = ? AND task_type = 'manual_upload_pending' AND status = 'canceled' AND created_at = ? AND payload = ?",
      ).bind(marker.id, marker.created_at, marker.payload).run();
      continue;
    }
    if (typeof payload.instanceId !== "string" || typeof payload.storageUri !== "string" ||
        typeof payload.uploadNonce !== "string" ||
        marker.id !== uploadMetadataMarkerId(payload.instanceId)) {
      await env.DB.prepare(
        "DELETE FROM work_queue WHERE id = ? AND task_type = 'manual_upload_pending' AND status = 'canceled' AND created_at = ? AND payload = ?",
      ).bind(marker.id, marker.created_at, marker.payload).run();
      continue;
    }

    const instance = await env.DB.prepare(
      `SELECT si.id, si.storage_uri, si.suffix, si.size, si.tag_scanned, a.cover_r2_key
         FROM song_instances si
         JOIN song_masters sm ON sm.id = si.master_id
         JOIN albums a ON a.id = sm.album_id
        WHERE si.id = ? AND si.source_type = 'original'
          AND si.tag_scanned IN (0, 1) AND si.missing = 0`,
    ).bind(payload.instanceId).first<{
      id: string; storage_uri: string; suffix: string; size: number | null; tag_scanned: number; cover_r2_key: string | null;
    }>();
    if (!instance) {
      await env.DB.prepare(
        "DELETE FROM work_queue WHERE id = ? AND task_type = 'manual_upload_pending' AND status = 'canceled' AND created_at = ? AND payload = ?",
      ).bind(marker.id, marker.created_at, marker.payload).run();
      continue;
    }
    if (payload.storageUri !== instance.storage_uri) {
      const nextMarkerPayload = JSON.stringify({ instanceId: instance.id, storageUri: instance.storage_uri, uploadNonce: payload.uploadNonce });
      const moved = await env.DB.prepare(
        "UPDATE work_queue SET payload = ? WHERE id = ? AND task_type = 'manual_upload_pending' AND status = 'canceled' AND created_at = ? AND payload = ?",
      ).bind(nextMarkerPayload, marker.id, marker.created_at, marker.payload).run();
      if ((moved.meta?.changes || 0) !== 1) continue;
      marker.payload = nextMarkerPayload;
      payload.storageUri = instance.storage_uri;
    }
    if (instance.tag_scanned === 1 && instance.cover_r2_key) {
      await env.DB.prepare(
        "DELETE FROM work_queue WHERE id = ? AND task_type = 'manual_upload_pending' AND status = 'canceled' AND created_at = ? AND payload = ?",
      ).bind(marker.id, marker.created_at, marker.payload).run();
      continue;
    }

    try {
      const task = await enqueueUploadMetadata(env.DB, env, { ...instance, uploadNonce: payload.uploadNonce });
      if (task.status === "stale_claimed") continue;
      const row = await env.DB.prepare("SELECT status, payload FROM work_queue WHERE id = ?")
        .bind(task.taskId).first<{ status: string; payload: string }>();
      const currentPayload = JSON.stringify({
        instanceId: instance.id, sourceUri: instance.storage_uri, suffix: instance.suffix,
        size: instance.size || 0, origin: "upload", uploadNonce: payload.uploadNonce,
      });
      if (row?.payload !== currentPayload || !["queued", "claimed"].includes(row.status)) continue;
      if (task.status === "queued") queued++;
    } catch (error) {
      console.error(`[upload-recovery] could not recover metadata for ${instance.id}:`, error);
    }
  }

  const candidates = (await env.DB.prepare(
    `SELECT si.id, si.storage_uri, si.suffix, si.size
       FROM song_instances si
       LEFT JOIN work_queue w
         ON w.id = 'wt-metadata-' || si.id
       LEFT JOIN work_queue marker
         ON marker.id = 'wm-upload-pending-' || si.id
      WHERE si.id LIKE 'si-upload-%'
        AND si.source_type = 'original'
        AND si.tag_scanned = 0
        AND si.missing = 0
        AND si.created_at <= ?
        AND w.id IS NULL
        AND marker.id IS NULL
      ORDER BY si.created_at ASC
      LIMIT ${RECOVERY_BATCH_SIZE}`,
  ).bind(cutoff).all<{ id: string; storage_uri: string; suffix: string; size: number | null }>()).results;

  for (const instance of candidates) {
    try {
      const task = await enqueueUploadMetadata(env.DB, env, instance);
      if (task.status === "queued") queued++;
    } catch (error) {
      console.error(`[upload-recovery] could not queue metadata for ${instance.id}:`, error);
    }
  }
  return queued;
}
