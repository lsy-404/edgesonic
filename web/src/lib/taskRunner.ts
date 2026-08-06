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

// Running one queued task: spawn a Worker, hand it a signed stream URL, keep
// the claim alive while it works, submit the outcome.
//
// Called by stores/workSocket.ts for each task the coordinator pushes.

export interface QueuedTask {
  id: string;
  taskType: string;
  payload: Record<string, unknown>;
  requiredCaps: string[];
  priority: number;
  attempts: number;
  maxAttempts: number;
  claimedAt: number;
  heartbeatAt: number;
}

// Shared by the client-side truncation and the server-side clamp in
// /work/submit. Three layers of 500-byte truncation is intentional: each
// protects its own surface from runaway error strings (memory churn on the
// worker, postMessage cost on the main thread, D1 column blowup on the server).
const ERR_LIMIT = 500;

/**
 * Prefix carries enough context to grep work_queue.error_message rows:
 *  "[metadata:abcd1234] HTTP 503 from r2-stream"
 *
 * The raw arg is intentionally `unknown` so callers can pass either Error
 * (from try/catch), ErrorEvent (from worker error listener), or a string
 * fallback.
 */
export function formatTaskError(
  task: { id: string; task_type: string },
  raw: unknown,
): string {
  let body: string;
  if (raw instanceof Error) {
    body = raw.message || raw.toString();
  } else if (typeof raw === "string") {
    body = raw;
  } else if (raw && typeof raw === "object" && "message" in raw && typeof (raw as { message: unknown }).message === "string") {
    body = (raw as { message: string }).message;
  } else {
    body = String(raw);
  }
  if (!body) body = "worker reported empty error";
  const prefixed = `[${task.task_type}:${task.id.slice(0, 8)}] ${body}`;
  return prefixed.length > ERR_LIMIT ? prefixed.slice(0, ERR_LIMIT) : prefixed;
}

// Best-effort: payloads from the scan dispatcher include either `sourceUri` or
// `storageUri`. We take the tail segment so the UI shows something readable
// instead of an instance UUID.
export function fileNameFrom(task: QueuedTask): string {
  const payload = task.payload || {};
  const candidate =
    typeof payload.sourceUri === "string" ? payload.sourceUri :
    typeof payload.storageUri === "string" ? payload.storageUri :
    "";
  if (candidate) {
    const tail = candidate.split("/").filter(Boolean).pop();
    if (tail) return tail;
  }
  return task.id.slice(0, 8);
}

export interface RunnerDeps {
  restUrl: (path: string, params?: Record<string, string | string[]>) => string;
  edgesonicPost: (path: string, body: unknown, signal?: AbortSignal) => Promise<string>;
}

export type RunOutcome =
  | { status: "ok" }
  | { status: "failed"; error: string }
  // Cancelled mid-flight. Neither success nor failure: the claimed row is left
  // alone and the server-side reclaim sweep returns it to the queue, so an
  // interruption never burns one of the task's attempts.
  | { status: "aborted" };

/**
 * Execute one task end to end and report the outcome to the server.
 * Never throws — every failure path resolves to a RunOutcome so a caller
 * draining a batch doesn't lose its siblings to one bad task.
 */
export async function runTask(
  task: QueuedTask,
  deps: RunnerDeps,
  signal: AbortSignal,
): Promise<RunOutcome> {
  let worker: Worker | null = null;
  const stopHeartbeat = startHeartbeat(task.id, deps, signal);
  try {
    // The `new URL(...)` form is the Vite-supported syntax for typed Web
    // Worker imports (no glob, no string-only).
    worker = new Worker(
      new URL("../workers/taskExecutor.ts", import.meta.url),
      { type: "module" },
    );

    // A metadata task can't fetch a logical `webdav://` URI directly, so we
    // hand it a signed /rest/stream URL built on the main thread — the
    // credentials stay in the main-thread origin.
    const augmented: QueuedTask = JSON.parse(JSON.stringify(task));
    if (task.taskType === "metadata") {
      const instanceId = String(task.payload.instanceId || "");
      if (instanceId) {
        augmented.payload.streamUrl = deps.restUrl("stream", { id: instanceId });
      }
    }

    const result = await runWorkerOnce(worker, augmented, signal);
    if (signal.aborted) return { status: "aborted" };
    await deps.edgesonicPost("work/submit", { id: task.id, result }, signal);
    return { status: "ok" };
  } catch (e) {
    if (signal.aborted) return { status: "aborted" };
    const error = formatTaskError({ id: task.id, task_type: task.taskType }, e);
    // Report the failure so the row goes back to queued (or to failed if
    // attempts are exhausted). We deliberately ignore the submit's own
    // response — if the network is down too, the reclaim sweep catches it.
    try { await deps.edgesonicPost("work/submit", { id: task.id, error }); }
    catch { /* ignore */ }
    return { status: "failed", error };
  } finally {
    stopHeartbeat();
    if (worker) worker.terminate();
  }
}

// Keep the claim alive while the task runs.
//
// The server marks a claim stale once heartbeat_at is older than
// worker_claim_ttl_seconds (60s by default) and hands the row to somebody
// else. Anything slower than that — any real transcode — was being reclaimed
// and re-run underneath itself, because nothing on this side had ever sent a
// heartbeat. Half the TTL is the usual margin: one lost beat still leaves
// time for the next.
const HEARTBEAT_MS = 30_000;

function startHeartbeat(
  taskId: string,
  deps: RunnerDeps,
  signal: AbortSignal,
): () => void {
  const timer = setInterval(() => {
    if (signal.aborted) return;
    // A rejected heartbeat means the claim is already gone (reclaimed, or
    // cancelled by an admin). Nothing useful to do about it here: the submit
    // at the end will report the same thing, so stay quiet rather than
    // spamming the console on a queue that is being drained elsewhere.
    void deps.edgesonicPost("work/heartbeat", { id: taskId }, signal).catch(() => {});
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/**
 * One-shot worker round-trip. Resolves with the result payload or rejects with
 * the error from the worker side. Rejects immediately if `signal` fires
 * mid-flight so the caller can terminate the Worker rather than wait it out.
 */
export function runWorkerOnce(
  worker: Worker,
  task: QueuedTask,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const onMessage = (e: MessageEvent) => {
      if (e.data && typeof e.data === "object") {
        if ("ok" in e.data) {
          if (e.data.ok) resolve(e.data.result);
          else reject(new Error(e.data.error || "worker reported failure"));
          cleanup();
        }
        // Progress messages keep streaming until the final {ok: ..} arrives.
      }
    };
    const onError = (e: ErrorEvent) => {
      // The message is often redacted for module workers by the cross-origin
      // security policy. Fall back to the inner Error, then the event type, so
      // the downstream formatter never sees "".
      const msg = e.message
        || (e.error instanceof Error ? e.error.message : "")
        || `worker fired ${e.type || "error"} event`;
      reject(new Error(msg));
      cleanup();
    };
    const onAbort = () => {
      reject(new DOMException("aborted", "AbortError"));
      cleanup();
    };
    function cleanup() {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
    worker.postMessage(task);
  });
}
