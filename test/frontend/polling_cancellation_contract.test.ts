// Source-level contracts for page polling cancellation and single-flight behavior.
// Run: npx tsx test/frontend/polling_cancellation_contract.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const sources = read("web/src/views/Sources.vue");
const work = read("web/src/views/WorkMode.vue");
const podcasts = read("web/src/views/Podcasts.vue");

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

assert(sources.includes("let pollInFlight: Promise<void> | null = null"), "Sources status polling has a single-flight guard");
assert(sources.includes("pollController.abort()"), "Sources aborts an active status request when polling stops");
assert(sources.includes("window.setTimeout") && sources.includes("pollScanStatus().finally"), "Sources schedules the next poll after the previous request settles");
assert(sources.includes("loadController?.abort()"), "Sources aborts the source list request on unmount");

assert(work.includes("let progressInFlight: Promise<void> | null = null"), "WorkMode progress polling has a single-flight guard");
assert(work.includes("progressController?.abort()"), "WorkMode aborts progress loading on unmount");
assert(work.includes("loadProgress().finally(scheduleProgressPoll)"), "WorkMode schedules progress polling after completion");

assert(podcasts.includes("let loadInFlight: Promise<void> | null = null"), "Podcasts list loading has a single-flight guard");
assert(podcasts.includes("loadController?.abort()"), "Podcasts aborts list loading on unmount");
assert(podcasts.includes("loadAll().finally(() =>"), "Podcasts schedules the next poll after list loading settles");
assert(podcasts.includes("for (const handle of delayedReloads) clearTimeout(handle)"), "Podcasts clears delayed reload timers on unmount");
assert(!/setInterval\([^\n]*load(All|Progress|ScanStatus)/.test(`${sources}\n${work}\n${podcasts}`), "Polling no longer uses async setInterval callbacks");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
