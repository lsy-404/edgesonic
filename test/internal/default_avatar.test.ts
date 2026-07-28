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

// The generated avatar is drawn by the browser and by the worker from the same
// module, so both sides must agree for any given name.
//
// Run: npx tsx test/internal/default_avatar.test.ts
import { defaultAvatarColor, defaultAvatarInitial, defaultAvatarSvg } from "../../shared/avatar";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function main() {
  console.log("colour is stable per account:");
  {
    assert(defaultAvatarColor("alice") === defaultAvatarColor("alice"), "same name, same colour");
    const palette = new Set(["alice", "bob", "carol", "dave", "erin"].map(defaultAvatarColor));
    assert(palette.size > 1, "different names spread across the palette");
    assert(/^#[0-9a-f]{6}$/i.test(defaultAvatarColor("alice")), "colour is a hex triplet");
    assert(/^#[0-9a-f]{6}$/i.test(defaultAvatarColor("")), "empty name still yields a colour");
  }

  console.log("initial handles real-world names:");
  {
    assert(defaultAvatarInitial("alice") === "A", "ascii is upper-cased");
    assert(defaultAvatarInitial("  bob") === "B", "leading space ignored");
    assert(defaultAvatarInitial("罗小黑") === "罗", "cjk keeps its first character");
    assert(defaultAvatarInitial("😀joy") === "😀", "astral char is not split");
    assert(defaultAvatarInitial("") === "?", "empty name falls back");
    assert(defaultAvatarInitial("   ") === "?", "blank name falls back");
  }

  console.log("svg is self-contained and safe:");
  {
    const svg = defaultAvatarSvg("alice");
    assert(svg.startsWith("<svg") && svg.endsWith("</svg>"), "single svg root");
    assert(svg.includes(defaultAvatarColor("alice")), "uses the account colour");
    assert(svg.includes(">A</text>"), "renders the initial");
    assert(!svg.includes("<image") && !svg.includes("href="), "no external references");

    const hostile = defaultAvatarSvg('"><script>alert(1)</script>');
    assert(!hostile.includes("<script>"), "name cannot inject markup");
    assert(hostile.includes("&lt;") || hostile.includes("&quot;"), "name is escaped");

    assert(defaultAvatarSvg("alice", 64).includes('width="64"'), "size is honoured");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
