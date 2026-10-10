import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchMissingMetadataPages } from "../../web/src/lib/missingMetadataDispatch";

const page = (nextCursor: string | null, counts = { scanned: 100, enqueued: 70, skipped: 30 }) => ({ ok: true, ...counts, nextCursor });

test("walks every page through the terminal null cursor", async () => {
  const requested: Array<string | undefined> = [];
  const progress: Array<{ scanned: number; nextCursor: string | undefined }> = [];
  const result = await dispatchMissingMetadataPages({
    signal: new AbortController().signal,
    request: async (after) => {
      requested.push(after);
      return after === undefined ? page("B") : page(null, { scanned: 4, enqueued: 2, skipped: 2 });
    },
    onPage: ({ scanned, nextCursor }) => progress.push({ scanned, nextCursor }),
  });

  assert.deepEqual(requested, [undefined, "B"]);
  assert.deepEqual(progress, [{ scanned: 100, nextCursor: "B" }, { scanned: 104, nextCursor: undefined }]);
  assert.deepEqual(result, { scanned: 104, enqueued: 72, skipped: 32, nextCursor: undefined });
});

test("retains the last successful cursor when a later page fails", async () => {
  const requested: Array<string | undefined> = [];
  let lastCursor: string | undefined;
  let lastScanned = 0;
  await assert.rejects(() => dispatchMissingMetadataPages({
    signal: new AbortController().signal,
    request: async (after) => {
      requested.push(after);
      if (after === "B") throw new Error("network interruption");
      return page("B");
    },
    onPage: ({ nextCursor, scanned }) => { lastCursor = nextCursor; lastScanned = scanned; },
  }), /network interruption/);

  assert.deepEqual(requested, [undefined, "B"]);
  assert.equal(lastCursor, "B");
  assert.equal(lastScanned, 100);

  const resumed: Array<string | undefined> = [];
  await dispatchMissingMetadataPages({
    after: lastCursor,
    signal: new AbortController().signal,
    request: async (after) => {
      resumed.push(after);
      return page(null, { scanned: 1, enqueued: 1, skipped: 0 });
    },
    onPage: () => undefined,
  });
  assert.deepEqual(resumed, ["B"]);
});

test("rejects a cursor sequence that moves backward after advancing", async () => {
  const requested: Array<string | undefined> = [];
  await assert.rejects(() => dispatchMissingMetadataPages({
    after: "A",
    signal: new AbortController().signal,
    request: async (after) => {
      requested.push(after);
      return page(after === "A" ? "B" : "A");
    },
    onPage: (progress) => {
      if (progress.nextCursor !== "B") assert.fail("backward cursor must not be reported as progress");
    },
  }), /cursor did not advance/);
  assert.deepEqual(requested, ["A", "B"]);
});

test("rejects malformed cursors and unbounded counts", async () => {
  await assert.rejects(() => dispatchMissingMetadataPages({
    signal: new AbortController().signal,
    request: async () => ({ ok: true, scanned: 101, enqueued: 70, skipped: 30, nextCursor: null }),
    onPage: () => assert.fail("malformed page must not be reported as progress"),
  }), /Invalid scanned count/);
  await assert.rejects(() => dispatchMissingMetadataPages({
    signal: new AbortController().signal,
    request: async () => ({ ok: true, scanned: 1, enqueued: 1, skipped: 0 }),
    onPage: () => assert.fail("missing cursor must not be reported as success"),
  }), /missing its next cursor/);
  await assert.rejects(() => dispatchMissingMetadataPages({
    signal: new AbortController().signal,
    request: async () => ({ ok: true, scanned: 1, enqueued: 1, skipped: 0, nextCursor: 42 }),
    onPage: () => assert.fail("invalid cursor must not be reported as progress"),
  }), /Invalid dispatch cursor/);
});

test("stops before requesting another page when aborted", async () => {
  const controller = new AbortController();
  const requested: Array<string | undefined> = [];
  const result = await dispatchMissingMetadataPages({
    signal: controller.signal,
    request: async (after) => {
      requested.push(after);
      return page("B");
    },
    onPage: () => controller.abort(),
  });

  assert.deepEqual(requested, [undefined]);
  assert.deepEqual(result, { scanned: 100, enqueued: 70, skipped: 30, nextCursor: "B" });
});
