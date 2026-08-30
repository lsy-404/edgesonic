// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/internal/klrc_sidecar.test.ts

import { parseSidecarToRich } from "../../worker/src/utils/richLyrics";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  const rich = await parseSidecarToRich(
    "track.klrc",
    new TextEncoder().encode("[ti:Track]\n[ar:Artist]\n[00:00.000]First lyric\n[00:01.000]Second lyric"),
  );

  assert(rich !== null, "parses a KLRC text sidecar");
  assert(rich?.tracks[0]?.line.length === 2, "metadata does not become 0-second lyric lines");
  assert(rich?.tracks[0]?.line[0]?.start === 0, "keeps an explicit zero-second lyric timestamp");
  assert(rich?.tracks[0]?.line[1]?.start === 1000, "keeps later lyric timestamps");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exitCode = failures ? 1 : 0;
}

void main();
