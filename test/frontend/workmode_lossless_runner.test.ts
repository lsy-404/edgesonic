import assert from "node:assert/strict";
import test from "node:test";
import { runTask, type QueuedTask } from "../../web/src/lib/taskRunner";

class MockWorker extends EventTarget {
  task: unknown;
  terminate() {}
  postMessage(value: unknown) {
    if ((value as { cancel?: boolean }).cancel) {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: { ok: false, error: "aborted" },
      })));
      return;
    }
    this.task = value;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: { ok: true, result: { registered: true } },
    })));
  }
}

test("lossless tasks retain their signed stream URL and claim identity", async () => {
  const originalWorker = globalThis.Worker;
  let worker: MockWorker | undefined;
  globalThis.Worker = class extends MockWorker {
    constructor() {
      super();
      worker = this;
    }
  } as unknown as typeof Worker;
  const task: QueuedTask = {
    id: "work-1", taskType: "lossless", payload: { instanceId: "instance-1", sourceSize: 512, streamUrl: "/signed/source?token=claim-bound" },
    requiredCaps: ["lossless"], priority: 0, attempts: 2, maxAttempts: 3,
    claimedAt: 1234, heartbeatAt: 1234,
  };
  const submissions: unknown[] = [];
  try {
    const outcome = await runTask(task, {
      restUrl: (path, params) => `/rest/${path}?id=${params?.id}&source=${params?.source}`,
      edgesonicPost: async (_path, body) => { submissions.push(body); return "{}"; },
    }, new AbortController().signal);
    assert.deepEqual(outcome, { status: "ok" });
    assert.deepEqual(worker?.task, {
      ...task,
      payload: {
        ...task.payload,
        streamUrl: "/signed/source?token=claim-bound",
        attempts: 2,
        claimedAt: 1234,
      },
    });
    assert.equal(submissions.length, 1);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test("lossless cancellation leaves the claim unsubmitted", async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class extends MockWorker {} as unknown as typeof Worker;
  const task: QueuedTask = {
    id: "work-2", taskType: "lossless", payload: { instanceId: "instance-2", streamUrl: "/signed/source?token=claim-bound" },
    requiredCaps: ["lossless"], priority: 0, attempts: 1, maxAttempts: 3,
    claimedAt: 4321, heartbeatAt: 4321,
  };
  const controller = new AbortController();
  const submissions: unknown[] = [];
  try {
    const pending = runTask(task, {
      restUrl: () => "/rest/stream",
      edgesonicPost: async (_path, body) => { submissions.push(body); return "{}"; },
    }, controller.signal);
    controller.abort();
    assert.deepEqual(await pending, { status: "aborted" });
    assert.equal(submissions.length, 0);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
