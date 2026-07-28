// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Bitrate is measured from the stored file rather than trusted from a parser
// that may only have seen a slice of it.
//
// Run: npx tsx test/internal/audio_metrics.test.ts
import { deriveBitrate, bitrateNeedsRepair } from "../../worker/src/utils/audioMetrics";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function main() {
  console.log("measurement matches real files:");
  {
    // The FLAC that exposed the defect: 27,210,162 bytes over 228s ≈ 955 kbps,
    // stored as 39.
    assert(deriveBitrate(27_210_162, 228) === 955, "lossless track measures ~955 kbps");
    // CD-quality WAV: 44100 × 16 × 2 = 1411 kbps.
    assert(deriveBitrate(44_100 * 2 * 2 * 60, 60) === 1411, "cd-quality wav measures 1411 kbps");
    assert(deriveBitrate(320_000 / 8 * 180, 180) === 320, "320 kbps mp3 measures 320");
  }

  console.log("unmeasurable rows yield nothing rather than a wrong number:");
  {
    assert(deriveBitrate(0, 100) === null, "zero size");
    assert(deriveBitrate(null, 100) === null, "missing size");
    assert(deriveBitrate(1_000_000, 0) === null, "zero duration");
    assert(deriveBitrate(1_000_000, null) === null, "missing duration");
    assert(deriveBitrate(1_000_000, 0.4) === null, "sub-second duration is not trusted");
    assert(deriveBitrate(Number.NaN, 100) === null, "NaN size");
    // A byte count with a nonsense duration would imply an impossible rate.
    assert(deriveBitrate(50_000_000_000, 1) === null, "implausible rate rejected");
  }

  console.log("repair only fires on real disagreement:");
  {
    assert(bitrateNeedsRepair(39, 955), "an order-of-magnitude gap needs repair");
    assert(bitrateNeedsRepair(null, 955), "a missing rate needs repair");
    assert(bitrateNeedsRepair(0, 955), "a zero rate needs repair");
    assert(!bitrateNeedsRepair(955, 955), "an exact match is left alone");
    assert(!bitrateNeedsRepair(1000, 955), "container overhead is tolerated");
    assert(!bitrateNeedsRepair(312, 320), "vbr wobble is tolerated");
    // Size includes tags and cover art, so the measurement runs high on small
    // lossy files; a correct-looking rate must not be replaced by that.
    assert(!bitrateNeedsRepair(104, 174), "artwork-inflated measurement leaves a plausible rate alone");
    assert(bitrateNeedsRepair(66, 355), "a 5x gap is repaired");
    assert(bitrateNeedsRepair(2000, 320), "an over-stated rate is repaired too");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
