// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/web/files_upload_sync.test.ts

import {
  classifyUploadItems,
  isUploadIncluded,
  uploadPathFor,
} from "../../web/src/lib/uploadQueue";
import { mapConcurrent } from "../../web/src/lib/concurrency";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

type FakeFile = { name: string; webkitRelativePath?: string };
const files = (entries: Array<[string, string?]>): FakeFile[] => entries.map(([name, webkitRelativePath]) => ({ name, webkitRelativePath }));

async function run() {
console.log("files upload synchronization:");

const separateDirs = classifyUploadItems(files([
  ["track.flac", "disc-1/track.flac"],
  ["track.mp3", "disc-2/track.mp3"],
]));
assert(separateDirs.every((item) => item.kind === "audio"), "same stem in different relative directories is not an audio variant");

const sameDir = classifyUploadItems(files([
  ["track.flac", "disc-1/track.flac"],
  ["track.mp3", "disc-1/track.mp3"],
]));
assert(sameDir[0].kind === "audio" && sameDir[1].kind === "variant", "second audio of the same stem and directory is a variant");

const companions = classifyUploadItems(files([
  ["track.lrc", "disc-1/track.lrc"],
  ["track.ttml", "disc-1/track.ttml"],
  ["track.ncm", "disc-1/track.ncm"],
  ["cover.jpg", "disc-1/cover.jpg"],
]));
assert(companions[0].kind === "lyrics" && companions[1].kind === "lyrics", "LRC and TTML are lyrics sidecars");
assert(companions[2].kind === "encrypted" && !companions[2].selected, "encrypted input is recognized and excluded by default");
assert(companions[3].kind === "sidecar", "ordinary non-audio companion remains uploadable");

const selection = classifyUploadItems(files([
  ["track.flac", "album/track.flac"],
  ["track.mp3", "album/track.mp3"],
  ["track.lrc", "album/track.lrc"],
  ["track.ncm", "album/track.ncm"],
]));
selection[1].selected = false;
const included = selection.filter((item) => isUploadIncluded(item, { includeLyrics: true, includeVariants: true }));
assert(included.map((item) => item.file.name).join(",") === "track.flac,track.lrc", "per-item selection excludes an individual variant while keeping selected lyrics");
assert(!isUploadIncluded(selection[2], { includeLyrics: false, includeVariants: true }), "global lyrics switch excludes selected lyric sidecars");

assert(uploadPathFor("music", sameDir[0]) === "music/disc-1", "top-level selected directory stays beneath the current music target");
assert(uploadPathFor("music/import/", sameDir[0]) === "music/import/disc-1", "current target path is preserved before the selected relative directory");
assert(uploadPathFor("music", classifyUploadItems(files([["single.flac"]]))[0]) === "music", "plain multi-file selection keeps the current target without an invented directory");

let active = 0;
let peak = 0;
const completed: number[] = [];
await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
  active++;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 2));
  completed.push(item);
  active--;
});
assert(peak === 3 && completed.length === 7, "the shared upload queue runs all files with at most three in flight");

if (failures) process.exitCode = 1;
}

void run();
