import assert from "node:assert/strict";
import { shouldAutoStartSso } from "../../web/src/utils/sso";

const base = {
  mode: "required" as const,
  available: true,
  loading: false,
  hasCallbackResult: false,
  hasCallbackError: false,
  optedOut: false,
};

assert.equal(shouldAutoStartSso(base), true);
assert.equal(shouldAutoStartSso({ ...base, hasCallbackResult: true }), false);
assert.equal(shouldAutoStartSso({ ...base, hasCallbackError: true }), false);
assert.equal(shouldAutoStartSso({ ...base, optedOut: true }), false);
assert.equal(shouldAutoStartSso({ ...base, mode: "optional" }), false);
assert.equal(shouldAutoStartSso({ ...base, available: false }), false);

console.log("required SSO auto-start loop guards passed");
