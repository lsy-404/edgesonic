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

// Renders the icon component through Vue's SSR path so a broken slot or a
// dropped nudge wrapper fails here instead of shipping as an invisible glyph.
//
// Run: npx vite-node -c test/frontend/vite-node.config.mts test/frontend/icon_render.test.ts
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import Icon from "../../web/src/components/Icon.vue";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function render(name: string): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(Icon, { name }) }));
}

async function main() {
  console.log("every icon renders drawable content:");
  {
    const names = [
      "check", "cross", "warn", "info", "play", "left", "right", "copy", "empty",
      "ban", "flag", "lock", "search", "music", "heart", "star", "note", "folder",
      "edit", "refresh", "up", "down", "dot", "dots", "queueNext", "gear", "download",
    ];
    let bad = "";
    for (const n of names) {
      const html = await render(n);
      if (!/<(path|circle|rect)\b/.test(html)) { bad = n; break; }
    }
    assert(!bad, bad ? `every icon draws (missing: ${bad})` : `all ${names.length} icons draw a shape`);
  }

  console.log("off-centre glyphs carry their nudge:");
  {
    const note = await render("note");
    assert(note.includes('transform="translate(1.25 0)"'), "note is nudged right");
    assert(/<g[^>]*transform[^>]*>[\s\S]*<path/.test(note), "nudge wraps the drawing, not replaces it");
    const folder = await render("folder");
    assert(folder.includes('transform="translate(0 -1.25)"'), "folder is nudged up");
  }

  console.log("centred glyphs are left alone:");
  {
    const check = await render("check");
    assert(!check.includes("transform"), "check renders without a wrapper");
    assert(check.includes("M3.5 8.5l3 3 6-7"), "check keeps its path");
  }

  console.log("download icon exists as its own glyph:");
  {
    const download = await render("download");
    const dot = await render("dot");
    assert(download !== dot, "download does not fall back to the dot placeholder");
    assert(download.includes("M8 2v8"), "download draws the arrow shaft");
  }

  console.log("unknown names still render the placeholder:");
  {
    const unknown = await render("no-such-icon");
    assert(unknown.includes("<circle"), "unknown name falls back to dot");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("UNCAUGHT", e); process.exit(2); });
