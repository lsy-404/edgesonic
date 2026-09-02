// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseXmlAttrs } from "../../web/src/lib/xmlAttrs";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const xml = '<subsonic-response><song id="gray" title="灰色 &amp; 蓝色" artist="A &amp; B" album="&#x7070;&#33394;" /></subsonic-response>';
const song = parseXmlAttrs(xml, "song")[0];

assert(song.title === "灰色 & 蓝色", "song title decodes XML ampersand entities");
assert(song.artist === "A & B", "song artist decodes XML ampersand entities");
assert(song.album === "灰色", "song title metadata decodes numeric entities");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
