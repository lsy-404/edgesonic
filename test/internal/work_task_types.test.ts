import assert from "node:assert/strict";
import { parseWorkTaskTypes } from "../../worker/src/coordinator/workTaskTypes";

assert.deepEqual(parseWorkTaskTypes('["metadata","lossless"]'), ["metadata", "lossless"]);
assert.deepEqual(parseWorkTaskTypes("[]"), []);
for (const invalid of [null, "", "metadata", "{}", "[\"metadata\",\"metadata\"]",
  "[\"unknown\"]", "[null]", "[\"metadata\",3]"]) {
  assert.equal(parseWorkTaskTypes(invalid), null, `reject ${String(invalid)}`);
}

console.log("work task type selection validation: PASS");
