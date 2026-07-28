import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const player = fs.readFileSync(path.join(root, "web/src/stores/player.ts"), "utf-8");
const nowPlaying = fs.readFileSync(path.join(root, "web/src/views/NowPlaying.vue"), "utf-8");

const currentDownloadCallback = player.match(
  /startFullDownload\(\s*targetEl,[\s\S]*?async \(blob\) => \{([\s\S]*?)\n\s*\},\n\s*\(error\)/,
)?.[1] ?? "";
const clearsSourceBeforeCacheLookup = player.indexOf('targetEl.removeAttribute("src")')
  < player.indexOf("const cached = await getCachedTrack(trackId)");

const checks: [string, boolean][] = [
  ["switching tracks unloads the previous source before cache lookup", clearsSourceBeforeCacheLookup],
  // The finished download deliberately takes over playback from the live
  // stream, and must carry the position and play/pause state across the swap.
  ["background completion hands playback to the local copy", currentDownloadCallback.includes("playPreparedBlob")],
  ["the swap preserves position and play state", currentDownloadCallback.includes("targetEl.currentTime")
    && currentDownloadCallback.includes("shouldPlay")],
  ["the swap is skipped once the track changed", currentDownloadCallback.includes("current.value?.id !== trackId")],
  ["track changes reset lyric state synchronously", nowPlaying.includes('{ immediate: true, flush: "sync" }')],
  ["track changes cancel the previous lyric return timer", nowPlaying.includes("clearTimeout(lyricsReturnTimer)") && nowPlaying.includes("lyricsReturnTimer = null")],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else { failures++; console.error(`  FAIL ${label}`); }
}

if (failures > 0) process.exit(1);
