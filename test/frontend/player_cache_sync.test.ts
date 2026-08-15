import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const player = fs.readFileSync(path.join(root, "web/src/stores/player.ts"), "utf-8");
const nowPlaying = fs.readFileSync(path.join(root, "web/src/views/NowPlaying.vue"), "utf-8");

const currentCacheMiss = player.match(
  /const sourceUrl = streamUrl\(trackId, streamQualityParams\(\)\);([\s\S]*?)targetEl\.volume = volume\.value;/,
)?.[1] ?? "";
const clearsSourceBeforeCacheLookup = player.indexOf('targetEl.removeAttribute("src")')
  < player.indexOf("const cached = await getCachedTrackAtOrAboveQuality(trackId)");

const checks: [string, boolean][] = [
  ["switching tracks unloads the previous source before cache lookup", clearsSourceBeforeCacheLookup],
  ["a cache miss starts the native stream", currentCacheMiss.includes("targetEl.src = sourceUrl")],
  ["a cache miss does not start a competing full download", !currentCacheMiss.includes("startFullDownload")],
  ["a cache miss does not switch playback to a Blob", !currentCacheMiss.includes("playPreparedBlob")],
  ["cache lookup accepts equal or higher quality", player.includes("cacheKeyCandidates") && player.includes("getCachedTrackAtOrAboveQuality")],
  ["cache lookup rejects lower quality", player.includes("QUALITY_RANK[candidate] >= minRank")],
  ["unknown auto quality is not substituted", player.includes('candidate === "auto"') && player.includes('requested === "auto"')],
  ["higher-quality cache hits require browser support", player.includes("canUseCachedQuality(candidate, quality)")],
  ["original-file retry is restricted to automatic quality", player.includes('if (!quality) attempts.push(["download-full", downloadUrl(trackId)]);')],
  ["quality changes discard old preloads", /watch\(playbackQuality,[\s\S]*?invalidatePreload\(\);/.test(player)],
  ["quality changes reload active playback", /watch\(playbackQuality,[\s\S]*?loadCurrent\(shouldPlay\);/.test(player)],
  ["stale quality cache lookups cannot replace playback", player.includes("playbackQuality.value !== requestedQuality")],
  ["next-track preload starts with a safe active runway", player.includes("bufferedAhead(el) >= NEXT_TRACK_PRELOAD_BUFFER_SECONDS")],
  ["next-track audio fetch uses low priority", player.includes('fetchFullBlob(trackId, state.controller.signal, "low")')],
  ["track changes reset lyric state synchronously", nowPlaying.includes('{ immediate: true, flush: "sync" }')],
  ["track changes cancel the previous lyric return timer", nowPlaying.includes("clearTimeout(lyricsReturnTimer)") && nowPlaying.includes("lyricsReturnTimer = null")],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else { failures++; console.error(`  FAIL ${label}`); }
}

if (failures > 0) process.exit(1);
