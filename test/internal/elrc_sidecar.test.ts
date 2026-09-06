// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/internal/elrc_sidecar.test.ts

import { parseSidecarToRich } from "../../worker/src/utils/richLyrics";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  const rich = await parseSidecarToRich(
    "track.elrc",
    new TextEncoder().encode("[ti:Track]\n[ar:Artist]\n[00:00.000]First lyric\n[00:01.000]Second lyric"),
  );

  assert(rich !== null, "parses an ELRC text sidecar");
  assert(rich?.tracks[0]?.line.length === 2, "metadata does not become 0-second lyric lines");
  assert(rich?.tracks[0]?.line[0]?.start === 0, "keeps an explicit zero-second lyric timestamp");
  assert(rich?.tracks[0]?.line[1]?.start === 1000, "keeps later lyric timestamps");

  const wordLevel = await parseSidecarToRich(
    "word-level.elrc",
    new TextEncoder().encode("[0,1000]<0,400,0>逐<400,600,0>字\n[1000,500]<0,500,0>歌词"),
  );
  const firstCueLine = wordLevel?.tracks[0]?.cueLine[0];
  assert(wordLevel !== null, "parses the ELRC word marker form");
  assert(firstCueLine?.cue.length === 2, "keeps each word as a separate cue");
  assert(firstCueLine?.cue[0]?.value === "逐" && firstCueLine.cue[0].start === 0 && firstCueLine.cue[0].end === 400,
    "first word preserves its absolute start and duration");
  assert(firstCueLine?.cue[1]?.value === "字" && firstCueLine.cue[1].start === 400 && firstCueLine.cue[1].end === 1000,
    "second word begins at its ELRC offset");

  const angleTimed = await parseSidecarToRich(
    "angle-timed.elrc",
    new TextEncoder().encode("[00:00.000]<00:00.000>逐<00:00.400>字\n[00:01.000]<00:01.000>歌<00:01.250>词"),
  );
  const angleCueLine = angleTimed?.tracks[0]?.cueLine[0];
  assert(angleTimed !== null, "parses angle-timestamped ELRC");
  assert(angleCueLine?.cue.length === 2, "angle-timestamped words become separate cues");
  assert(angleCueLine?.cue[1]?.value === "字" && angleCueLine.cue[1].start === 400,
    "angle timestamp converts to an absolute millisecond cue time");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exitCode = failures ? 1 : 0;
}

void main();
