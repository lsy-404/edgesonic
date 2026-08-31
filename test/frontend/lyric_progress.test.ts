// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/frontend/lyric_progress.test.ts

import { cuePlaybackProgress } from "../../web/src/lib/lyricProgress";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const lines = [
  {
    time: 1,
    synced: true,
    cues: [{ start: 1, end: 1.4 }, { start: 1.4, end: 2 }],
  },
  { time: 2, synced: true, cues: [{ start: 2 }] },
];

console.log("Cue fill progress:");
assert(cuePlaybackProgress(lines, 0, 0, 0.9, 5) === 0, "a future cue is unfilled");
assert(cuePlaybackProgress(lines, 0, 0, 1.2, 5) === 0.5, "an active cue fills proportionally instead of jumping");
assert(cuePlaybackProgress(lines, 0, 0, 1.4, 5) === 1, "a completed cue remains fully filled");
assert(cuePlaybackProgress(lines, 0, 1, 1.7, 5) === 0.5, "the next cue starts its own independent fill");
assert(cuePlaybackProgress(lines, 1, 0, 3.5, 5) === 0.5, "a last cue without an end uses the following playback boundary");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
