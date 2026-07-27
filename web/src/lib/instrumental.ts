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

// Backing-track detection for the "hide instrumentals" list filter.
//
// Releases mark backing tracks with a suffix on the title rather than a tag,
// so the only signal available client-side is the trailing marker: bracketed
// ("(Instrumental)", "【伴奏】") or appended ("- inst.", "曲名。INST.", "／伴奏").
// Anchoring to the end of the string keeps titles that merely contain a marker
// word ("Instrumental Analysis", "伴奏者的独白") in the list.

const LATIN_MARKER =
  String.raw`(?:instrumentals?|insts?|off[\s-]*vocals?|no[\s-]*vocals?|vocals?[\s-]*off|karaoke)`;

const CJK_MARKER =
  String.raw`(?:カラオケ|オフ[\s-]*ボーカル|インスト(?:ゥルメンタル)?|伴奏|去人[声聲]|[无無]人[声聲]|消音)`;

const MARKER = `(?:${LATIN_MARKER}|${CJK_MARKER})`;

// Optional trailing qualifier: "(Instrumental Version)", "伴奏版", "inst mix".
const QUALIFIER = String.raw`(?:\s*(?:ver\.?|version|mix|edit|track|版|バージョン))?`;

const OPEN = String.raw`[(（\[［【{｛「]`;
const CLOSE = String.raw`[)）\]］】}｝」]`;

// A latin marker needs a non-alphanumeric char in front of it so that a title
// merely ending in those letters ("Fight Against" contains "inst") is left
// alone; any punctuation counts, including CJK ("曲名。INST."). CJK markers
// carry no such ambiguity and may sit flush against the title.
const TRAILING_MARKER = new RegExp(
  "(?:" +
    `${OPEN}\\s*${MARKER}${QUALIFIER}\\s*\\.?\\s*${CLOSE}` +
    "|" +
    `(?:^|[^A-Za-z0-9])${LATIN_MARKER}${QUALIFIER}\\.?` +
    "|" +
    `${CJK_MARKER}${QUALIFIER}\\.?` +
  ")\\s*$",
  "i",
);

/** True when the title carries a trailing backing-track marker. */
export function isInstrumentalTitle(title: string | undefined | null): boolean {
  if (!title) return false;
  return TRAILING_MARKER.test(title.trim());
}
