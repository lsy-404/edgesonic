// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/frontend/files_playback.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const root = join(__dirname, "..", "..");
const files = readFileSync(join(root, "web", "src", "views", "Files.vue"), "utf8");

console.log("File-page playback:");
assert(files.includes('import { usePlayerStore, type Track } from "../stores/player";'), "uses the shared player store");
assert(files.includes("const isPlayableAudio = (file: FileEntry)"), "recognizes playable file entries");
assert(files.includes("async function playFile(f: FileEntry)"), "defines a file playback handler");
assert(files.includes("const hit = await lookupSongByFilename(f, 20);"), "resolves the existing library song before playing");
assert(files.includes("player.setQueue([toTrack(hit)], 0);"), "starts the shared player with the resolved track");
assert(files.includes("v-if=\"isPlayableAudio(f)\"") && files.includes("@click.stop=\"playFile(f)\""), "audio rows expose a direct play button");
assert(files.includes("v-if=\"isPlayableAudio(ctxFile)\"") && files.includes("playFile(ctxFile!)"), "the context menu also exposes playback");
assert(!files.includes("streamUrl(f.uri"), "does not bypass the player's source selection with a raw file URI");

const localeKeys = ["play", "playLookupFailed"];
for (const locale of ["en", "zh-CN"]) {
  const messages = JSON.parse(readFileSync(join(root, "web", "src", "locales", `${locale}.json`), "utf8"));
  for (const key of localeKeys) assert(typeof messages.files?.[key] === "string", `${locale} provides files.${key}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
