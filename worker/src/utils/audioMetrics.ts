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

// Average bitrate of a stored track. Parsers report the rate of whatever they
// were handed, and the browser pool hands them head+tail slices, so a reported
// rate can be a small fraction of the real one. File size over duration is
// exact for a complete file and needs no I/O.

// Guards against dividing by a rounding artefact and against rates no real
// audio file reaches (uncompressed 192kHz/24bit/8ch is still under 40 Mbps).
const MIN_DURATION_SEC = 1;
const MAX_PLAUSIBLE_KBPS = 50_000;

/** kbps for the given byte count and seconds, or null when not measurable. */
export function deriveBitrate(
  sizeBytes: number | null | undefined,
  durationSec: number | null | undefined,
): number | null {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC) return null;
  const kbps = Math.round((sizeBytes * 8) / durationSec / 1000);
  if (kbps <= 0 || kbps > MAX_PLAUSIBLE_KBPS) return null;
  return kbps;
}

/**
 * Whether a stored rate is wrong enough to be worth rewriting.
 *
 * The measurement counts tags and embedded artwork as audio, so it runs a
 * little high — on a short lossy track with a large cover, noticeably so.
 * Repair therefore requires a factor-of-two disagreement, which is what the
 * slice-parsing defect produces (roughly 20x low) while leaving a merely
 * approximate lossy rate alone rather than replacing it with an inflated one.
 */
const REPAIR_RATIO = 2;

export function bitrateNeedsRepair(stored: number | null | undefined, measured: number): boolean {
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored <= 0) return true;
  return stored * REPAIR_RATIO < measured || measured * REPAIR_RATIO < stored;
}
