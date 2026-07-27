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

// Run: npx tsx test/frontend/instrumental_filter.test.ts

import { isInstrumentalTitle } from "../../web/src/lib/instrumental";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const instrumentals = [
  "Song Name (Instrumental)",
  "Song Name (Instrumental Version)",
  "Song Name (inst.)",
  "Song Name [Inst]",
  "Song Name - Instrumental",
  "Song Name -inst",
  "Song Name_inst",
  "Song Name (Off Vocal)",
  "Song Name (off-vocal)",
  "Song Name (Karaoke Version)",
  "曲名（伴奏）",
  "曲名【伴奏】",
  "曲名 伴奏",
  "曲名／伴奏版",
  "曲名 - 无人声",
  "曲名（消音）",
  "曲名（カラオケ）",
  "曲名 (インスト)",
  "Instrumental",
  // Real library titles: the marker sits flush against a CJK full stop.
  "请不要带我走。INST.",
  "底色theory。INST.",
  "完？美？友！人！INST.",
  "我？爱？你？INST.",
];

const keepers = [
  "Song Name",
  "Instrumental Analysis",
  "Instrumentals of the Baroque Era",
  "Karaoke Night in Shibuya",
  "伴奏者的独白",
  "Off Vocal Training Manual",
  "Fight Against",
  "请不要带我走。",
  "完？美？友！人！",
  "Song Name (Live)",
  "Song Name (2023 Remaster)",
  "Song Name (Instrumental) [2023 Remaster]",
];

console.log("isInstrumentalTitle — trailing markers are detected:");
for (const title of instrumentals) assert(isInstrumentalTitle(title), title);

console.log("isInstrumentalTitle — regular titles are kept:");
for (const title of keepers) assert(!isInstrumentalTitle(title), title);

console.log("isInstrumentalTitle — empty input:");
assert(!isInstrumentalTitle(""), "empty string is not instrumental");
assert(!isInstrumentalTitle(undefined), "undefined is not instrumental");

if (failures) process.exit(1);
