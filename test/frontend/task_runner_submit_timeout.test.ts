// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { runTask, type QueuedTask } from "../../web/src/lib/taskRunner";

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

  postMessage() {
    queueMicrotask(() => {
      for (const listener of this.listeners.get("message") ?? []) {
        listener({ data: { ok: true, result: { tags: { title: "Parsed" } } } });
      }
    });
  }

  terminate() {}
}

Object.defineProperty(globalThis, "Worker", { value: MockWorker, configurable: true });

const task: QueuedTask = {
  id: "metadata-timeout", taskType: "metadata", payload: { instanceId: "si-1" },
  requiredCaps: ["music-metadata"], priority: 5, attempts: 2, maxAttempts: 3,
  claimedAt: 1000000001, heartbeatAt: 1000000001,
};

async function main() {
  const calls: Array<{ path: string; body: any }> = [];
  const outcome = await runTask(task, {
    restUrl: () => "https://example.test/rest/stream",
    async edgesonicPost(path, body) {
      calls.push({ path, body });
      throw new Error("submission timed out after server accepted it");
    },
  }, new AbortController().signal);

  assert.equal(outcome.status, "failed");
  assert.equal(calls.length, 1, "a success timeout must not send a contradictory error submit");
  assert.equal(calls[0].path, "work/submit");
  assert.equal(calls[0].body.attempts, 2);
  assert.equal(calls[0].body.claimedAt, 1000000001);
  assert.deepEqual(calls[0].body.result, { tags: { title: "Parsed" } });
  assert.equal(calls[0].body.error, undefined);
  console.log("task runner submit timeout: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
