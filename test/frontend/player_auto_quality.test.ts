// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  isAutomaticPlaybackQuality,
  normalizePlaybackQuality,
  streamQualityParamsForQuality,
} from "../../web/src/lib/playbackQuality";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  PASS ${message}`);
  else { failures++; console.error(`  FAIL ${message}`); }
}

console.log("automatic playback quality:");
const automatic = streamQualityParamsForQuality("auto");
assert(automatic.format === "raw", "sends an explicit raw stream request");
assert(automatic.maxBitRate === undefined, "does not carry a bitrate cap");
assert(isAutomaticPlaybackQuality("auto"), "keeps original-file recovery available for automatic playback");
assert(normalizePlaybackQuality("retired-quality") === "auto", "stale saved values fall back to automatic raw playback");

const manual = streamQualityParamsForQuality("mp3-128");
assert(manual.format === "mp3" && manual.maxBitRate === 128, "manual quality still requests its codec and bitrate");
assert(!isAutomaticPlaybackQuality("mp3-128"), "manual quality does not use original-file recovery");

process.exitCode = failures ? 1 : 0;
