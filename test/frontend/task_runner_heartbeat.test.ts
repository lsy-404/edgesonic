// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The claim heartbeat, which for a long time only existed on the server.
//
// worker_claim_ttl_seconds seeds at 60s and reclaimStaleWork hands any claim
// older than that to somebody else. Nothing in the browser ever POSTed
// /work/heartbeat, so every task slower than a minute — which is every real
// transcode — was being reclaimed and re-run underneath itself. Pushing made
// that worse, because the re-dispatch is now immediate rather than whenever
// the next poll happened to land.
//
// The interval lives inside runTask, which needs a Worker and Vite-only URL
// syntax, so this checks the contract against the source plus the arithmetic
// that makes the margin correct.

import fs from "node:fs";
import path from "node:path";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const runnerPath = path.resolve(__dirname, "../../web/src/lib/taskRunner.ts");
const schemaPath = path.resolve(__dirname, "../../worker/migrations/Schema.sql");

function main(): void {
  const src = fs.readFileSync(runnerPath, "utf-8");

  console.log("the client half of the heartbeat contract exists:");
  {
    assert(src.includes('"work/heartbeat"'),
      "runTask POSTs work/heartbeat");
    assert(/setInterval\(/.test(src),
      "it repeats rather than firing once");
    assert(/clearInterval/.test(src),
      "and is torn down when the task ends");
    assert(/finally[\s\S]{0,120}stopHeartbeat\(\)/.test(src),
      "teardown is in a finally, so a thrown task cannot leak the interval");
  }

  console.log("\nthe interval leaves margin against the server TTL:");
  {
    const m = src.match(/HEARTBEAT_MS\s*=\s*([\d_]+)/);
    assert(!!m, "HEARTBEAT_MS is declared");
    const heartbeatMs = parseInt((m?.[1] ?? "0").replace(/_/g, ""), 10);

    const schema = fs.readFileSync(schemaPath, "utf-8");
    const seed = schema.match(/'worker_claim_ttl_seconds',\s*'(\d+)'/);
    assert(!!seed, "worker_claim_ttl_seconds is still seeded in Schema.sql");
    const ttlMs = parseInt(seed?.[1] ?? "0", 10) * 1000;

    assert(heartbeatMs > 0 && ttlMs > 0, `both values parsed (beat ${heartbeatMs}ms, ttl ${ttlMs}ms)`);
    assert(heartbeatMs <= ttlMs / 2,
      `a lost beat still leaves time for the next (${heartbeatMs}ms ≤ ${ttlMs / 2}ms)`);
  }

  console.log("\na rejected heartbeat is not fatal:");
  {
    // The claim may legitimately be gone — reclaimed, or cancelled by an
    // admin. The submit at the end reports that; the heartbeat should not
    // also throw into an unhandled rejection.
    assert(/work\/heartbeat[\s\S]{0,160}\.catch\(/.test(src),
      "the heartbeat POST has its own catch");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
