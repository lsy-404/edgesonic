import assert from "node:assert/strict";
import { runTask, type QueuedTask } from "../../web/src/lib/taskRunner";

const delivered: QueuedTask[] = [];

class MockWorker {
  private listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(task: QueuedTask) {
    delivered.push(task);
    queueMicrotask(() => {
      for (const listener of this.listeners.get("message") ?? []) {
        listener({ data: { ok: true, result: { tags: {} } } });
      }
    });
  }

  terminate() {}
}

Object.defineProperty(globalThis, "Worker", { value: MockWorker, configurable: true });

const sourceId = "si-specific-wav";
const request: QueuedTask = {
  id: "metadata-specific-wav",
  taskType: "metadata",
  payload: { instanceId: sourceId },
  requiredCaps: ["metadata"],
  priority: 3,
  attempts: 0,
  maxAttempts: 3,
  claimedAt: 0,
  heartbeatAt: 0,
};
const calls: Array<{ path: string; body: unknown }> = [];
async function main() {
  const outcome = await runTask(request, {
    restUrl(path, params) {
      const url = new URL(`https://example.test/rest/${path}`);
      for (const [key, value] of Object.entries(params ?? {})) {
        url.searchParams.set(key, String(value));
      }
      return url.toString();
    },
    async edgesonicPost(path, body) {
      calls.push({ path, body });
      return "{}";
    },
  }, new AbortController().signal);

  assert.deepEqual(outcome, { status: "ok" });
  assert.equal(delivered.length, 1);
  const streamUrl = new URL(String(delivered[0].payload.streamUrl));
  assert.equal(streamUrl.pathname, "/rest/stream");
  assert.equal(streamUrl.searchParams.get("id"), sourceId);
  assert.equal(streamUrl.searchParams.get("source"), sourceId);
  assert.deepEqual(request.payload, { instanceId: sourceId });
  assert.deepEqual(calls, [{ path: "work/submit", body: { id: request.id, result: { tags: {} } } }]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
