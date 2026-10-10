import assert from "node:assert/strict";
import { DEFAULT_WORK_TASK_TYPES, encodeWorkTaskTypes, parseWorkTaskTypes, supportsBrowserFfmpeg, WORK_TASK_TYPES } from "../../web/src/lib/workTypes";

assert.deepEqual(parseWorkTaskTypes(null), DEFAULT_WORK_TASK_TYPES);
assert.deepEqual(parseWorkTaskTypes("[]"), []);
assert.deepEqual(parseWorkTaskTypes('["lossless","metadata","metadata","invalid"]'), ["metadata", "lossless"]);
assert.deepEqual(parseWorkTaskTypes("not-json"), DEFAULT_WORK_TASK_TYPES);
assert.equal(encodeWorkTaskTypes(["lossless", "metadata"]), '["metadata","lossless"]');
assert.equal(encodeWorkTaskTypes([]), "[]");
assert.deepEqual(WORK_TASK_TYPES, ["metadata", "transcode", "scrape", "lossless"]);
assert.equal(supportsBrowserFfmpeg({ WebAssembly, Worker: class {} as unknown as typeof Worker }), true);
assert.equal(supportsBrowserFfmpeg({ WebAssembly: undefined as never, Worker: class {} as unknown as typeof Worker }), false);
assert.equal(supportsBrowserFfmpeg({ WebAssembly, Worker: undefined as never }), false);

console.log("Work task selection tests passed");
