// SPDX-License-Identifier: AGPL-3.0-or-later

import { dispatchWork } from "../endpoints/edgesonic/work";

export interface UploadMetadataTaskInput {
  id: string;
  storage_uri: string;
  suffix: string;
  size: number | null;
  uploadNonce?: string;
}

export interface UploadMetadataTaskPayload {
  instanceId: string;
  sourceUri: string;
  suffix: string;
  size: number;
  origin: "upload";
  uploadNonce?: string;
}

export interface UploadMetadataLease {
  markerId: string;
  payload: string;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

export const UPLOAD_METADATA_LEASE_TTL_SECONDS = 120;

export function uploadMetadataMarkerId(instanceId: string): string {
  return `wm-upload-pending-${instanceId}`;
}

export async function markUploadMetadataPending(
  db: D1Database,
  instanceId: string,
  storageUri: string,
  uploadNonce: string,
  createdAt = Math.floor(Date.now() / 1000),
): Promise<UploadMetadataLease | null> {
  const result = await db.prepare(
    `INSERT INTO work_queue (id, task_type, payload, status, created_at, claimed_at, heartbeat_at)
     VALUES (?, 'manual_upload_pending', ?, 'claimed', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       task_type = excluded.task_type, payload = excluded.payload, status = 'claimed',
       required_caps = NULL, priority = 5, claimed_by = NULL, claimed_at = excluded.claimed_at,
       heartbeat_at = excluded.heartbeat_at, result_json = NULL, error_message = NULL, attempts = 0,
       max_attempts = 3, created_at = excluded.created_at
     WHERE work_queue.status != 'claimed'`,
  ).bind(uploadMetadataMarkerId(instanceId), JSON.stringify({ instanceId, storageUri, uploadNonce }), createdAt, createdAt, createdAt).run();
  const markerId = uploadMetadataMarkerId(instanceId);
  const payload = JSON.stringify({ instanceId, storageUri, uploadNonce });
  return result.meta?.changes === 1 ? startLeaseHeartbeat(db, markerId, payload) : null;
}

export async function acquireUploadPathLease(
  db: D1Database,
  markerId: string,
  storageUri: string,
  uploadNonce: string,
  createdAt = Math.floor(Date.now() / 1000),
): Promise<UploadMetadataLease | null> {
  const payload = JSON.stringify({ markerId, storageUri, uploadNonce });
  const result = await db.prepare(
    `INSERT INTO work_queue (id, task_type, payload, status, created_at, claimed_at, heartbeat_at)
     VALUES (?, 'manual_upload_pending', ?, 'claimed', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       payload = excluded.payload, status = 'claimed', claimed_by = NULL,
       claimed_at = excluded.claimed_at, heartbeat_at = excluded.heartbeat_at,
       created_at = excluded.created_at, attempts = 0, max_attempts = 3
     WHERE work_queue.status != 'claimed'`,
  ).bind(markerId, payload, createdAt, createdAt, createdAt).run();
  return result.meta?.changes === 1 ? startLeaseHeartbeat(db, markerId, payload) : null;
}

export async function acquireUploadMetadataLease(
  db: D1Database,
  instanceId: string,
  storageUri: string,
  uploadNonce?: string,
): Promise<UploadMetadataLease | null> {
  const markerId = uploadMetadataMarkerId(instanceId);
  const marker = await db.prepare(
    "SELECT payload, status FROM work_queue WHERE id = ? AND task_type = 'manual_upload_pending'",
  ).bind(markerId).first<{ payload: string; status: string }>();
  if (marker) {
    if (!uploadNonce || !["canceled", "completed"].includes(marker.status)) return null;
    let generation: { instanceId?: unknown; storageUri?: unknown; uploadNonce?: unknown };
    try { generation = JSON.parse(marker.payload) as typeof generation; }
    catch { return null; }
    if (generation.instanceId !== instanceId || generation.storageUri !== storageUri || generation.uploadNonce !== uploadNonce) return null;
    const update = await db.prepare(
      "UPDATE work_queue SET status = 'claimed', claimed_at = ?, heartbeat_at = ? WHERE id = ? AND task_type = 'manual_upload_pending' AND status = ? AND payload = ?",
    ).bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), markerId, marker.status, marker.payload).run();
    if (update.meta?.changes !== 1) return null;
    return startLeaseHeartbeat(db, markerId, marker.payload);
  }

  if (uploadNonce) return null;
  const leasePayload = JSON.stringify({ instanceId, storageUri, leaseNonce: crypto.randomUUID() });
  const insert = await db.prepare(
    "INSERT INTO work_queue (id, task_type, payload, status, created_at, claimed_at, heartbeat_at) VALUES (?, 'manual_upload_pending', ?, 'claimed', ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).bind(markerId, leasePayload, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).run();
  if (insert.meta?.changes !== 1) return null;
  return startLeaseHeartbeat(db, markerId, leasePayload);
}

function startLeaseHeartbeat(db: D1Database, markerId: string, payload: string): UploadMetadataLease {
  const timer = setInterval(() => {
    void db.prepare(
      "UPDATE work_queue SET heartbeat_at = ? WHERE id = ? AND task_type = 'manual_upload_pending' AND status = 'claimed' AND payload = ?",
    ).bind(Math.floor(Date.now() / 1000), markerId, payload).run().catch((error) => {
      console.error(`[upload-metadata] lease heartbeat failed for ${markerId}:`, error);
    });
  }, 15_000);
  return { markerId, payload, heartbeatTimer: timer };
}

export async function releaseUploadMetadataLease(
  db: D1Database,
  lease: UploadMetadataLease,
  completed: boolean,
): Promise<boolean> {
  clearInterval(lease.heartbeatTimer);
  const result = await db.prepare(
    "UPDATE work_queue SET status = ?, claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL WHERE id = ? AND task_type = 'manual_upload_pending' AND status = 'claimed' AND payload = ?",
  ).bind(completed ? "completed" : "canceled", lease.markerId, lease.payload).run();
  return result.meta?.changes === 1;
}

export async function recoverStaleUploadMetadataLeases(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const result = await db.prepare(
    `UPDATE work_queue
        SET status = 'canceled', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
      WHERE task_type = 'manual_upload_pending' AND status = 'claimed'
        AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`,
  ).bind(now - UPLOAD_METADATA_LEASE_TTL_SECONDS).run();
  return result.meta?.changes || 0;
}

export async function enqueueUploadMetadata(
  db: D1Database,
  env: Env,
  instance: UploadMetadataTaskInput,
): Promise<{ taskId: string; status: "queued" | "claimed" | "stale_claimed" | "completed" | "failed" | "canceled" }> {
  const taskId = `wt-metadata-${instance.id}`;
  const expected = JSON.stringify({
    instanceId: instance.id,
    sourceUri: instance.storage_uri,
    suffix: instance.suffix,
    size: instance.size || 0,
    origin: "upload",
    ...(instance.uploadNonce ? { uploadNonce: instance.uploadNonce } : {}),
  } satisfies UploadMetadataTaskPayload);
  const existing = await db.prepare("SELECT status, payload FROM work_queue WHERE id = ?")
    .bind(taskId).first<{ status: "queued" | "claimed" | "completed" | "failed" | "canceled"; payload: string }>();
  if (existing?.status === "claimed") {
    return { taskId, status: existing.payload === expected ? "claimed" : "stale_claimed" };
  }
  if (existing?.status === "queued") {
    if (existing.payload === expected) return { taskId, status: "queued" };
    await db.prepare(
      "UPDATE work_queue SET payload = ?, required_caps = '[\"music-metadata\"]', priority = 5 WHERE id = ? AND status = 'queued'",
    ).bind(expected, taskId).run();
    const refreshed = await db.prepare("SELECT status, payload FROM work_queue WHERE id = ?")
      .bind(taskId).first<{ status: "queued" | "claimed"; payload: string }>();
    if (refreshed?.payload === expected) return { taskId, status: refreshed.status };
    if (refreshed?.status === "claimed") {
      return { taskId, status: refreshed.payload === expected ? "claimed" : "stale_claimed" };
    }
  }

  await dispatchWork(db, {
    taskType: "metadata",
    payload: {
      instanceId: instance.id,
      sourceUri: instance.storage_uri,
      suffix: instance.suffix,
      size: instance.size || 0,
      origin: "upload",
      ...(instance.uploadNonce ? { uploadNonce: instance.uploadNonce } : {}),
    },
    requiredCaps: ["music-metadata"],
    priority: 5,
    dedupKey: instance.id,
    upsert: true,
  }, env);

  const after = await db.prepare("SELECT status FROM work_queue WHERE id = ?")
    .bind(taskId).first<{ status: "queued" | "claimed" | "completed" | "failed" | "canceled" }>();
  return { taskId, status: after?.status || "queued" };
}
