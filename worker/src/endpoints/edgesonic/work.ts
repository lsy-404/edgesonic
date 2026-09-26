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
// All endpoints are JSON-shaped (the /edgesonic/* bucket is web-session only,
// the web frontend consumes JSON). Authorisation matrix:
//
//   GET  /edgesonic/work/socket   — permission participate_work
//   GET  /edgesonic/work/agents   — permission dispatch_work (super-admin)
//   POST /edgesonic/work/submit   — claimed_by must equal current user
//  POST /edgesonic/work/heartbeat — claimed_by must equal current user
//   POST /edgesonic/work/dispatch — permission dispatch_work (super-admin)
//   GET  /edgesonic/work/status   — level >= 3 (super-admin)
//   POST /edgesonic/work/cancel   — level >= 3 (super-admin)
//
// Claiming happens in one place only: the coordinator object, which pushes
// each claimed row down the socket of the browser it picked. It still uses
// D1's RETURNING clause on an UPDATE constrained to status='queued', so two
// concurrent dispatches collide harmlessly. caps filtering is done in JS
// because D1 has no array containment operator.
//
// Because nothing pulls any more, every path that makes a row runnable must
// wake the coordinator — see wakePool below and its callers. A row queued
// without a wake waits for the reclaim sweep, which is the slow path.
//
// Stale claims are reclaimed by the coordinator alarm and the scheduled sweep.

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { getFeatureString } from "../../utils/features";
import { applyMetadataResult } from "../../utils/metadataApply";
import { writeEmbeddedCover } from "../../utils/embeddedCover";
import { acquireUploadMetadataLease, releaseUploadMetadataLease, uploadMetadataMarkerId, type UploadMetadataLease } from "../../utils/uploadMetadataQueue";
import { notifyCoordinator } from "../../coordinator/workCoordinator";
import type { User } from "../../types/entities";

export const workRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

async function applyQueuedMetadata(
  db: D1Database,
  instanceId: string,
  tags: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<{ updated: boolean; masterId?: string; reason?: string; uploadLease?: UploadMetadataLease }> {
  if (payload.origin === "upload") {
    if (payload.instanceId !== instanceId) return { updated: false, reason: "upload task instance mismatch" };
    const instance = await db.prepare("SELECT master_id, storage_uri, tag_scanned FROM song_instances WHERE id = ? AND source_type = 'original'")
      .bind(instanceId).first<{ master_id: string; storage_uri: string; tag_scanned: number }>();
    if (!instance) return { updated: false, reason: "upload instance not found" };
    if ((typeof payload.sourceUri === "string" && payload.sourceUri !== instance.storage_uri) ||
        (typeof payload.uploadNonce === "string" && payload.sourceUri !== instance.storage_uri)) {
      return { updated: false, reason: "upload source changed" };
    }

    const pending = await db.prepare(
      "SELECT payload, status FROM work_queue WHERE id = ? AND task_type = 'manual_upload_pending'",
    ).bind(uploadMetadataMarkerId(instanceId)).first<{ payload: string; status: string }>();
    if (pending) {
      let generation: { storageUri?: unknown; uploadNonce?: unknown } | null = null;
      try { generation = JSON.parse(pending.payload) as { storageUri?: unknown; uploadNonce?: unknown }; }
      catch { return { updated: false, reason: "invalid upload generation" }; }
      if (generation?.storageUri !== instance.storage_uri ||
          typeof generation.uploadNonce !== "string" ||
          generation.uploadNonce !== payload.uploadNonce) {
        return { updated: false, reason: "upload generation changed" };
      }
    }

    // A completed direct parse owns its tags; matching queued work may still add its cover.
    if (instance.tag_scanned === 1) {
      const lease = await acquireUploadMetadataLease(
        db,
        instanceId,
        instance.storage_uri,
        typeof payload.uploadNonce === "string" ? payload.uploadNonce : undefined,
      );
      return lease
        ? { updated: true, masterId: instance.master_id, uploadLease: lease }
        : { updated: false, reason: "upload generation is being changed or applied" };
    }

    const lease = await acquireUploadMetadataLease(
      db,
      instanceId,
      instance.storage_uri,
      typeof payload.uploadNonce === "string" ? payload.uploadNonce : undefined,
    );
    if (!lease) return { updated: false, reason: "upload generation is being changed or applied" };
    try {
      const result = await applyMetadataResult(db, instanceId, tags, tags);
      if (!result.updated) {
        await releaseUploadMetadataLease(db, lease, false);
        return result;
      }
      return { ...result, uploadLease: lease };
    } catch (error) {
      await releaseUploadMetadataLease(db, lease, false);
      throw error;
    }
  }
  return applyMetadataResult(db, instanceId, tags, tags);
}

const APPLY_PENDING = "metadata_apply:pending";
const APPLYING_PREFIX = "metadata_apply:applying:";
const APPLY_LEASE_SECONDS = 10 * 60;

interface ApplyAnnotation {
  ok: boolean;
  reason?: string;
  masterId?: string;
}

async function applyCompletedMetadata(
  env: Env,
  taskId: string,
  payloadJson: string,
  result: unknown,
): Promise<ApplyAnnotation> {
  const applying = `${APPLYING_PREFIX}${crypto.randomUUID()}`;
  const acquired = await env.DB.prepare(
    `UPDATE work_queue SET error_message = ?, heartbeat_at = unixepoch()
     WHERE id = ? AND task_type = 'metadata' AND status = 'completed'
       AND error_message = ?`,
  ).bind(applying, taskId, APPLY_PENDING).run();
  if (acquired.meta.changes !== 1) return { ok: false, reason: "metadata apply already in progress" };

  let annotation: ApplyAnnotation = { ok: false, reason: "invalid metadata result" };
  let retry = false;
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const r = result as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object" || !r || typeof r !== "object" ||
        typeof r.instanceId !== "string" || r.instanceId !== payload.instanceId) {
      annotation = { ok: false, reason: "task result instance mismatch" };
    } else {
      const instanceId = r.instanceId;
      const tags = r.tags && typeof r.tags === "object" ? r.tags as Record<string, unknown> : {};
      const apply = await applyQueuedMetadata(env.DB, instanceId, tags, payload);
      annotation = apply.updated
        ? { ok: true, masterId: apply.masterId }
        : { ok: false, reason: apply.reason };
      if (!apply.updated && apply.reason === "upload generation is being changed or applied") retry = true;

      let coverFailed = false;
      if (apply.masterId && r.cover && typeof r.cover === "object") {
        const cover = r.cover as { data?: string; mime?: string };
        if (typeof cover.data === "string") {
          try {
            const coverStatus = await writeEmbeddedCover(
              env.DB, env.MUSIC_BUCKET, apply.masterId,
              cover as { data: string; mime?: string },
              apply.uploadLease
                ? { markerId: uploadMetadataMarkerId(instanceId), payload: apply.uploadLease.payload }
                : undefined,
            );
            coverFailed = coverStatus === "invalid";
          } catch (error) {
            coverFailed = true;
            retry = true;
            console.error(`[work/submit] cover write failed for ${instanceId}:`, error);
          }
        }
      }
      if (apply.uploadLease) {
        try {
          await releaseUploadMetadataLease(env.DB, apply.uploadLease, !coverFailed);
        } catch (error) {
          retry = true;
          console.error(`[work/submit] upload generation lease release failed for ${instanceId}:`, error);
        }
      }
    }
  } catch (error) {
    retry = true;
    annotation = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  await env.DB.prepare(
    `UPDATE work_queue SET error_message = ?
     WHERE id = ? AND status = 'completed' AND error_message = ?`,
  ).bind(retry ? APPLY_PENDING : null, taskId, applying).run();
  return annotation;
}

export async function recoverPendingMetadataApplies(env: Env, limit = 20): Promise<number> {
  await env.DB.prepare(
    `UPDATE work_queue SET error_message = ?
     WHERE status = 'completed' AND task_type = 'metadata'
       AND error_message GLOB 'metadata_apply:applying:*'
       AND heartbeat_at < unixepoch() - ?`,
  ).bind(APPLY_PENDING, APPLY_LEASE_SECONDS).run();
  const rows = (await env.DB.prepare(
    `SELECT id, payload, result_json FROM work_queue
     WHERE status = 'completed' AND task_type = 'metadata'
       AND error_message = ?
     ORDER BY heartbeat_at ASC LIMIT ?`,
  ).bind(APPLY_PENDING, Math.max(1, Math.min(limit, 100))).all<{
    id: string; payload: string; result_json: string | null;
  }>()).results;
  for (const row of rows) {
    let result: unknown = null;
    try { result = row.result_json ? JSON.parse(row.result_json) : null; }
    catch { /* invalid saved result is marked terminal by the apply helper */ }
    try { await applyCompletedMetadata(env, row.id, row.payload, result); }
    catch (error) { console.error(`[work/recover] metadata apply failed for ${row.id}:`, error); }
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// GET /edgesonic/work/socket — the only way to receive work.
// ---------------------------------------------------------------------------
// Upgrades to a WebSocket held by the coordinator object, which pushes claimed
// tasks down it the moment they are queued (and whatever is already queued, on
// join). Results still come back through /work/submit.
//
// 503 means "not available", not "try again in a moment": either the binding
// is missing or an admin has switched the pool off. The client is expected to
// treat it as a policy answer and stop retrying, rather than reconnect-looping.
workRoutes.get("/work/socket", permissionMiddleware("participate_work"), async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  if (!env.WORK_COORDINATOR) {
    return c.json({ ok: false, error: "Coordinator not configured" }, 503);
  }
  const enabled = (await getFeatureString(env, "worker_pool_enabled", "1")) !== "0";
  if (!enabled) {
    return c.json({ ok: false, error: "Worker pool is disabled" }, 503);
  }

  // The agent's identity comes from the authenticated session, never from the
  // client — claims are recorded against it and /work/submit checks ownership.
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Agent-User", user.username);
  headers.set("X-Agent-Caps", c.req.query("caps") || "");
  headers.set("X-Agent-Concurrency", c.req.query("concurrency") || "1");

  const id = env.WORK_COORDINATOR.idFromName("pool");
  return env.WORK_COORDINATOR.get(id).fetch(
    new Request("https://coordinator/join", { headers }),
  );
});

// ---------------------------------------------------------------------------
// GET /edgesonic/work/agents — who is currently holding a push socket.
// ---------------------------------------------------------------------------
workRoutes.get("/work/agents", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;
  if (!env.WORK_COORDINATOR) return c.json({ ok: true, agents: [] });
  const id = env.WORK_COORDINATOR.idFromName("pool");
  return env.WORK_COORDINATOR.get(id).fetch("https://coordinator/agents");
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/submit { id, attempts, claimedAt, result?, error? }
// ---------------------------------------------------------------------------
// Marks a claimed task as completed (success path) or failed (error path).
// Only the worker that claimed the task may submit — prevents another browser
// from polluting the result.
workRoutes.post("/work/submit", async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  let body: { id?: string; attempts?: number; claimedAt?: number; result?: unknown; error?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.id) return c.json({ ok: false, error: "Missing id" }, 400);
  if (!Number.isSafeInteger(body.attempts) || !Number.isSafeInteger(body.claimedAt)) {
    return c.json({ ok: false, error: "Missing claim identity" }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT status, claimed_by, attempts, claimed_at, max_attempts, task_type, payload FROM work_queue WHERE id = ?",
  ).bind(body.id).first<{
    status: string;
    claimed_by: string | null;
    attempts: number;
    claimed_at: number | null;
    max_attempts: number;
    task_type: string;
    payload: string;
  }>();
  if (!row) return c.json({ ok: false, error: "Task not found" }, 404);
  if (row.status !== "claimed") {
    return c.json({ ok: false, error: `Task is ${row.status}, not claimed` }, 409);
  }
  if (row.claimed_by !== user.username) {
    return c.json({ ok: false, error: "Task is claimed by another worker" }, 403);
  }
  if (row.attempts !== body.attempts || row.claimed_at !== body.claimedAt) {
    return c.json({ ok: false, error: "Claim has changed" }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  if (body.error) {
    // Failure path. If attempts exhausted → final 'failed', otherwise re-queue
    // for another browser to pick up. We deliberately keep error_message even
    // on re-queue so admins can read the prior failure reason in status.
    const willRetry = row.attempts < row.max_attempts;
    const result = await env.DB.prepare(
      `UPDATE work_queue
       SET status = ?, error_message = ?, claimed_by = NULL,
           claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?
         AND attempts = ? AND claimed_at = ?`,
    ).bind(willRetry ? "queued" : "failed", body.error.slice(0, 500),
      body.id, user.username, body.attempts, body.claimedAt).run();
    if (result.meta.changes === 0) return c.json({ ok: false, error: "Claim has changed" }, 409);
    if (willRetry) await wakePool(env).catch(() => {});
    return c.json({ ok: true, status: willRetry ? "queued" : "failed" });
  }

  // Persist the result and finish this exact claim before applying metadata.
  // A saved result can be replayed if the request stops during application.
  const resultJson = body.result === undefined ? null : JSON.stringify(body.result);
  if (resultJson && resultJson.length > 500_000) {
    return c.json({ ok: false, error: "Result is too large" }, 413);
  }
  const completed = await env.DB.prepare(
    `UPDATE work_queue
     SET status = 'completed', result_json = ?, error_message = ?,
         heartbeat_at = ?
     WHERE id = ? AND status = 'claimed' AND claimed_by = ?
       AND attempts = ? AND claimed_at = ?`,
  ).bind(resultJson, row.task_type === "metadata" ? APPLY_PENDING : null,
    now, body.id, user.username, body.attempts, body.claimedAt).run();
  if (completed.meta.changes === 0) return c.json({ ok: false, error: "Claim has changed" }, 409);
  const applyAnnotation = row.task_type === "metadata"
    ? await applyCompletedMetadata(env, body.id, row.payload, body.result)
    : undefined;
  return c.json({
    ok: true,
    status: "completed",
    ...(applyAnnotation ? { applied: applyAnnotation } : {}),
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/heartbeat { id, attempts, claimedAt }
// ---------------------------------------------------------------------------
// Long-running task keep-alive. The client should call this every
// worker_claim_ttl_seconds / 2 while a transcode is in-flight; metadata tasks
// are short enough to finish before the first heartbeat would be due.
workRoutes.post("/work/heartbeat", async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  let body: { id?: string; attempts?: number; claimedAt?: number };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.id) return c.json({ ok: false, error: "Missing id" }, 400);
  if (!Number.isSafeInteger(body.attempts) || !Number.isSafeInteger(body.claimedAt)) {
    return c.json({ ok: false, error: "Missing claim identity" }, 400);
  }

  // We UPDATE-AND-CHECK in a single statement: the WHERE clause guards both
  // ownership and current state, so the meta.changes tells us whether the
  // heartbeat landed.
  const result = await env.DB.prepare(
    `UPDATE work_queue
     SET heartbeat_at = unixepoch()
     WHERE id = ? AND status = 'claimed' AND claimed_by = ?
       AND attempts = ? AND claimed_at = ?`,
  ).bind(body.id, user.username, body.attempts, body.claimedAt).run();
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: "Not your claim or task no longer active" }, 409);
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/dispatch { task_type, payload, priority?, required_caps?, max_attempts? }
// ---------------------------------------------------------------------------
// Manually push a task onto the queue. Used by admins for ad-hoc work
// (re-scrape one album, force re-transcode a song) and by background entry
// points (scan.ts) for batch dispatches.
workRoutes.post("/work/dispatch", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;
  let body: {
    task_type?: string;
    payload?: unknown;
    priority?: number;
    required_caps?: string[];
    max_attempts?: number;
    expires_at?: number;
  };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.task_type || !ALLOWED_TASK_TYPES.has(body.task_type)) {
    return c.json({ ok: false, error: `Unknown task_type: ${body.task_type}` }, 400);
  }
  if (body.payload === undefined) {
    return c.json({ ok: false, error: "Missing payload" }, 400);
  }
  const id = await dispatchWork(env.DB, {
    taskType: body.task_type,
    payload: body.payload,
    priority: body.priority,
    requiredCaps: body.required_caps,
    maxAttempts: body.max_attempts,
    expiresAt: body.expires_at,
  }, env);
  return c.json({ ok: true, id });
});

// ---------------------------------------------------------------------------
// GET /edgesonic/work/status — admin overview.
// ---------------------------------------------------------------------------
// dispatch_work permission (super-admin by default); earlier code used a
// hardcoded `if (user.level < 3)` which violated the permission-model rule.
workRoutes.get("/work/status", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;

  // Aggregate by status.
  const counts = (await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM work_queue GROUP BY status`,
  ).all<{ status: string; n: number }>()).results;
  const byStatus: Record<string, number> = { queued: 0, claimed: 0, completed: 0, failed: 0, canceled: 0 };
  for (const r of counts) byStatus[r.status] = r.n;

  // Per-user active load — claimed tasks OR recently completed (last 60s)
  // so the "active workers" list doesn't flicker to empty between tasks.
  // GET /work/agents is the authoritative live roster; this is the historical
  // view, smoothed
  // when a task finishes but the next hasn't been claimed yet.
  const nowSec = Math.floor(Date.now() / 1000);
  const load = (await env.DB.prepare(
    `SELECT claimed_by AS username, COUNT(*) AS n
     FROM work_queue
     WHERE status = 'claimed' AND claimed_by IS NOT NULL
     GROUP BY claimed_by
     UNION ALL
     SELECT claimed_by AS username, COUNT(*) AS n
     FROM work_queue
     WHERE status = 'completed' AND claimed_by IS NOT NULL
       AND heartbeat_at IS NOT NULL AND heartbeat_at > ?
     GROUP BY claimed_by`,
  ).bind(nowSec - 60).all<{ username: string; n: number }>()).results;
  // Merge duplicate usernames from the UNION
  const merged = new Map<string, number>();
  for (const r of load) merged.set(r.username, (merged.get(r.username) ?? 0) + r.n);
  const loadMerged = Array.from(merged.entries()).map(([username, n]) => ({ username, n }));

  // Recent 100 rows (newest first) — surfaces stuck tasks at a glance.
  const recent = (await env.DB.prepare(
    `SELECT id, task_type, status, claimed_by, attempts, max_attempts,
            priority, created_at, heartbeat_at, error_message
     FROM work_queue
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all<{
    id: string;
    task_type: string;
    status: string;
    claimed_by: string | null;
    attempts: number;
    max_attempts: number;
    priority: number;
    created_at: number;
    heartbeat_at: number | null;
    error_message: string | null;
  }>()).results;

  return c.json({
    ok: true,
    counts: byStatus,
    load: loadMerged,
    recent,
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/cancel { id }
// ---------------------------------------------------------------------------
// Dispatch permission protects another worker's queued tasks.
workRoutes.post("/work/cancel", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;
  let body: { id?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.id) return c.json({ ok: false, error: "Missing id" }, 400);

  const result = await env.DB.prepare(
    `UPDATE work_queue
     SET status = 'canceled', error_message = COALESCE(error_message, 'canceled by admin')
     WHERE id = ? AND status NOT IN ('completed', 'canceled')`,
  ).bind(body.id).run();
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: "Task not found or already terminal" }, 404);
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/backfillCompleted
// ---------------------------------------------------------------------------
// Repairs completed results for instances that remain unscanned.
//
// We process rows sequentially (one applyMetadataResult per row) so a partial
// failure on row N doesn't cancel rows N+1..M. The response carries a small
// errors[] sample so admins can spot patterns (e.g. all failures hitting the
// same source) without exploding the JSON body.
//
// Admin-only — gated by dispatch_work (super-admin by default), same gate
// as /work/status. A regular worker should never need to trigger this.
workRoutes.post("/work/backfillCompleted",
  permissionMiddleware("dispatch_work"),
  async (c) => {
  const env = c.env as Env;

  // Hard cap the candidate set so a runaway call can't pull a million rows
  // into memory. The query optionally accepts ?limit= to override (admins
  // may want to chunk through millions of rows; default keeps the call cheap).
  const rawLimit = parseInt(c.req.query("limit") || "1000", 10);
  const limit = Math.max(1, Math.min(10000, Number.isFinite(rawLimit) ? rawLimit : 1000));

  const candidates = (await env.DB.prepare(
    `SELECT w.id, w.payload, w.result_json
     FROM work_queue w
     JOIN song_instances si ON si.id = CASE WHEN json_valid(w.payload)
       THEN json_extract(w.payload, '$.instanceId') ELSE NULL END
     WHERE w.status = 'completed'
       AND w.task_type = 'metadata'
       AND w.result_json IS NOT NULL
       AND w.error_message IS NULL
       AND si.tag_scanned = 0
     ORDER BY w.created_at ASC
     LIMIT ?`,
  ).bind(limit).all<{ id: string; payload: string; result_json: string }>()).results;

  let processed = 0;
  let applied = 0;
  let failed = 0;
  const errors: { id: string; error: string }[] = [];

  for (const cand of candidates) {
    processed++;
    try {
      const result = JSON.parse(cand.result_json) as Record<string, unknown>;
      const tags = (result.tags && typeof result.tags === "object")
        ? result.tags as Record<string, unknown>
        : {};
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(cand.payload);
        if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch { /* malformed payload */ }
      const instanceId = typeof result.instanceId === "string" ? result.instanceId : "";
      const apply = instanceId && instanceId === payload.instanceId
        ? await applyQueuedMetadata(env.DB, instanceId, tags, payload)
        : { updated: false, reason: "task result instance mismatch" };
      if (apply.updated) {
        applied++;
        if (apply.uploadLease) await releaseUploadMetadataLease(env.DB, apply.uploadLease, true);
      } else {
        failed++;
        if (errors.length < 20) errors.push({ id: cand.id, error: apply.reason || "unknown" });
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      if (errors.length < 20) errors.push({ id: cand.id, error: msg });
    }
  }

  return c.json({ ok: true, processed, applied, failed, errors });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/recheckMetadataNow
// ---------------------------------------------------------------------------
// (maybeRunMetadataRecheck / utils/metadataRecheck.ts), bypassing the
// metadata_recheck_interval_hours cadence gate so an admin can kick off a
// re-check immediately instead of waiting up to 24h. Same permission gate as
// the other work-queue admin endpoints.
workRoutes.post("/work/recheckMetadataNow",
  permissionMiddleware("dispatch_work"),
  async (c) => {
    const env = c.env as Env;
    const { runMetadataRecheck } = await import("../../utils/metadataRecheck");
    const result = await runMetadataRecheck(env.DB, env);
    return c.json({ ok: true, ...result });
  },
);

// ---------------------------------------------------------------------------
// POST /edgesonic/work/backfillLrcNow
// ---------------------------------------------------------------------------
// Manual trigger for the same selection+fill runLrcBackfill runs on its
// own cadence (utils/lrcBackfill.ts), bypassing lrc_backfill_interval_hours so
// an admin can kick off a sweep immediately. Same permission gate as the
// other work-queue admin endpoints. Unlike recheckMetadataNow this does not
// touch work_queue at all — the sidecar read happens synchronously here.
workRoutes.post("/work/backfillLrcNow",
  permissionMiddleware("dispatch_work"),
  async (c) => {
    const env = c.env as Env;
    const { runLrcBackfill } = await import("../../utils/lrcBackfill");
    const result = await runLrcBackfill(env.DB, env);
    return c.json({ ok: true, ...result });
  },
);

// ===========================================================================
// dispatchWork helper — shared with scan.ts (background batch dispatch).
// ===========================================================================
export interface DispatchInput {
  taskType: string;
  payload: unknown;
  priority?: number;
  requiredCaps?: string[];
  maxAttempts?: number;
  expiresAt?: number;
  // and the INSERT is INSERT OR IGNORE — re-dispatching the same logical task
  // (e.g. same song_instances.id metadata parse) is a no-op instead of piling
  // up duplicate rows in work_queue. Scan.ts uses this with the instanceId.
  dedupKey?: string;
  // dedupKey + plain INSERT OR IGNORE is a *one-shot-ever* mechanism:
  // once a row with that deterministic id exists (in ANY terminal state
  // completed/failed/canceled), every future re-dispatch under the same key
  // silently no-ops. That's correct for the common "don't pile up duplicates
  // while still queued/claimed" case, but wrong for an explicit force-rescan
  // — the whole point of "re-run the metadata pipeline anyway" is to make an
  // already-completed row runnable again. Set upsert=true to switch the
  // INSERT to `ON CONFLICT(id) DO UPDATE` so a stale row is kicked back to
  // 'queued' with a fresh attempts counter instead of being ignored. Only
  // meaningful when dedupKey is also set.
  upsert?: boolean;
}

const REDISPATCH_CONFLICT_CLAUSE = `
     ON CONFLICT(id) DO UPDATE SET
       status = 'queued', payload = excluded.payload, priority = excluded.priority,
       max_attempts = excluded.max_attempts, attempts = 0, error_message = NULL,
       claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
       result_json = NULL, expires_at = excluded.expires_at
     WHERE work_queue.status IN ('completed', 'failed', 'canceled')
       AND (work_queue.status != 'completed' OR work_queue.error_message IS NULL)`;

// `env` is required: nothing pulls from the queue any more, so a row inserted
// without waking the coordinator waits for the reclaim sweep. Callers that
// must defer the wake — because they still have to patch the payload before
// it is safe to hand out — pass `{ wake: false }` and call wakePool
// themselves once the row is complete.
export async function dispatchWork(
  db: D1Database,
  input: DispatchInput,
  env: Env,
  opts: { wake?: boolean } = {},
): Promise<string> {
  // a re-dispatch becomes a no-op; the caller still gets the canonical id back
  // and can look it up regardless of whether the INSERT actually inserted.
  const id = input.dedupKey
    ? `wt-${input.taskType}-${input.dedupKey}`
    : "wq-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  const priority = clampInt(input.priority ?? 5, 1, 10);
  const maxAttempts = clampInt(input.maxAttempts ?? 3, 1, 10);
  const requiredCapsJson = input.requiredCaps && input.requiredCaps.length > 0
    ? JSON.stringify(input.requiredCaps)
    : null;
  const insertVerb = input.dedupKey && !input.upsert ? "INSERT OR IGNORE INTO" : "INSERT INTO";
  const conflictClause = input.dedupKey && input.upsert ? REDISPATCH_CONFLICT_CLAUSE : "";
  await db.prepare(
    `${insertVerb} work_queue (id, task_type, payload, required_caps, priority,
                              status, max_attempts, expires_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)${conflictClause}`,
  ).bind(
    id,
    input.taskType,
    JSON.stringify(input.payload),
    requiredCapsJson,
    priority,
    maxAttempts,
    input.expiresAt ?? null,
  ).run();
  if (opts.wake !== false) await wakePool(env);
  return id;
}

// A coordinator that is unreachable, unconfigured or mid-restart must never
// fail the enqueue — the row is already durable, and the reclaim sweep plus
// the next dispatch trigger will still find it.
export async function wakePool(env: Env): Promise<void> {
  try { await notifyCoordinator(env); }
  catch (e) { console.error("[work] coordinator notify failed:", e); }
}

// Batch dispatch for scan results.
// One D1 INSERT per row via batch(), in chunks of 80 to stay under the D1
// batch limit. Returns the list of created ids so the caller can log.
export async function dispatchWorkBatch(
  db: D1Database,
  inputs: DispatchInput[],
  env: Env,
): Promise<string[]> {
  const ids: string[] = [];
  if (inputs.length === 0) return ids;

  const stmts: D1PreparedStatement[] = [];
  for (const input of inputs) {
    // Per-row decision so the same batch can mix deduped + non-deduped rows.
    const id = input.dedupKey
      ? `wt-${input.taskType}-${input.dedupKey}`
      : "wq-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    ids.push(id);
    const priority = clampInt(input.priority ?? 5, 1, 10);
    const maxAttempts = clampInt(input.maxAttempts ?? 3, 1, 10);
    const requiredCapsJson = input.requiredCaps && input.requiredCaps.length > 0
      ? JSON.stringify(input.requiredCaps)
      : null;
    const insertVerb = input.dedupKey && !input.upsert ? "INSERT OR IGNORE INTO" : "INSERT INTO";
    const conflictClause = input.dedupKey && input.upsert ? REDISPATCH_CONFLICT_CLAUSE : "";
    stmts.push(
      db.prepare(
        `${insertVerb} work_queue (id, task_type, payload, required_caps, priority,
                                    status, max_attempts, expires_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)${conflictClause}`,
      ).bind(
        id,
        input.taskType,
        JSON.stringify(input.payload),
        requiredCapsJson,
        priority,
        maxAttempts,
        input.expiresAt ?? null,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 80) {
    await db.batch(stmts.slice(i, i + 80));
  }
  // One wake for the whole batch: the coordinator drains as much as the
  // connected pool has capacity for, and freed capacity re-triggers dispatch.
  await wakePool(env);
  return ids;
}

// ===========================================================================
// Helpers
// ===========================================================================
const ALLOWED_TASK_TYPES = new Set(["metadata", "transcode", "scrape"]);

// caps parsing and matching now live with the only code that claims rows —
// the coordinator. They were duplicated here purely for the poll handler.

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
