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


import { isKnownMetadataIdentity } from "../../../shared/metadataRetrievalMatch";

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

const ERR_LIMIT = 500;

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

export function fileNameFrom(task: QueuedTask): string {
  const payload = task.payload || {};
  if (task.taskType === "scrape" && payload.kind === "metadata-retrieval") {
    const snapshot = payload.snapshot && typeof payload.snapshot === "object"
      ? payload.snapshot as Record<string, unknown>
      : {};
    const title = typeof snapshot.title === "string" ? snapshot.title.trim()
      : typeof payload.title === "string" ? payload.title.trim()
      : "";
    if (isKnownMetadataIdentity(title)) return title;
  }
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

export function prepareWorkerTask(
  task: QueuedTask,
  deps: RunnerDeps,
  origin?: string,
): QueuedTask {
  const augmented: QueuedTask = JSON.parse(JSON.stringify(task));
  if (task.taskType === "metadata") {
    const instanceId = String(task.payload.instanceId || "");
    if (instanceId) {
      augmented.payload.streamUrl = deps.restUrl("stream", { id: instanceId, source: instanceId });
    }
  }
  if (task.taskType === "scrape" && task.payload.kind === "metadata-retrieval") {
    if (!origin) throw new Error("Metadata retrieval requires the browser origin.");
    augmented.payload.scrapeProxyUrl = new URL("/tag/scrape", origin).toString();
  }
  if (task.taskType === "lossless") {
    if (typeof augmented.payload.streamUrl !== "string" || !augmented.payload.streamUrl) {
      throw new Error("The claimed lossless task has no signed source stream URL.");
    }
    augmented.payload.attempts = task.attempts;
    augmented.payload.claimedAt = task.claimedAt;
  }
  return augmented;
}

export type RunOutcome =
  | { status: "ok" }
  | { status: "failed"; error: string }
  | { status: "aborted" };

export async function runTask(
  task: QueuedTask,
  deps: RunnerDeps,
  signal: AbortSignal,
): Promise<RunOutcome> {
  let worker: Worker | null = null;
  const stopHeartbeat = startHeartbeat(task, deps, signal);
  try {
    worker = new Worker(
      new URL("../workers/taskExecutor.ts", import.meta.url),
      { type: "module" },
    );

    const origin = task.taskType === "scrape" && task.payload.kind === "metadata-retrieval"
      ? globalThis.location.origin
      : undefined;
    const augmented = prepareWorkerTask(task, deps, origin);

    let result: unknown;
    try {
      result = await runWorkerOnce(worker, augmented, signal);
    } catch (e) {
      if (signal.aborted) return { status: "aborted" };
      const error = formatTaskError({ id: task.id, task_type: task.taskType }, e);
      try {
        await deps.edgesonicPost("work/submit", {
          id: task.id, attempts: task.attempts, claimedAt: task.claimedAt, error,
        });
      } catch { /* reclaim handles an unreported failure */ }
      return { status: "failed", error };
    }
    if (signal.aborted) return { status: "aborted" };
    try {
      await deps.edgesonicPost("work/submit", {
        id: task.id, attempts: task.attempts, claimedAt: task.claimedAt, result,
      }, signal);
      return { status: "ok" };
    } catch (e) {
      if (signal.aborted) return { status: "aborted" };
      const error = formatTaskError({ id: task.id, task_type: task.taskType }, e);
      return { status: "failed", error };
    }
  } catch (e) {
    if (signal.aborted) return { status: "aborted" };
    const error = formatTaskError({ id: task.id, task_type: task.taskType }, e);
    try {
      await deps.edgesonicPost("work/submit", {
        id: task.id, attempts: task.attempts, claimedAt: task.claimedAt, error,
      });
    } catch { /* reclaim handles an unreported failure */ }
    return { status: "failed", error };
  } finally {
    stopHeartbeat();
    if (worker) worker.terminate();
  }
}

const HEARTBEAT_MS = 30_000;

function startHeartbeat(
  task: QueuedTask,
  deps: RunnerDeps,
  signal: AbortSignal,
): () => void {
  const timer = setInterval(() => {
    if (signal.aborted) return;
    void deps.edgesonicPost("work/heartbeat", {
      id: task.id, attempts: task.attempts, claimedAt: task.claimedAt,
    }, signal).catch(() => {});
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

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
      }
    };
    const onError = (e: ErrorEvent) => {
      const msg = e.message
        || (e.error instanceof Error ? e.error.message : "")
        || `worker fired ${e.type || "error"} event`;
      reject(new Error(msg));
      cleanup();
    };
    const onAbort = () => {
      worker.postMessage({ cancel: true });
      cancelTimer = setTimeout(() => {
        reject(new DOMException("aborted", "AbortError"));
        cleanup();
      }, 3000);
    };
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    function cleanup() {
      if (cancelTimer) clearTimeout(cancelTimer);
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
