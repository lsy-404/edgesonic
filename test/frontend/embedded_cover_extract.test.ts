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

// Client-side embedded-cover extraction from buffered audio bytes (cover-404
// fallback). Synthetic FLAC PICTURE and ID3v2 APIC fixtures.
//
// Run: npx tsx test/frontend/embedded_cover_extract.test.ts
import { extractEmbeddedCover } from "../../web/src/lib/embeddedCover";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function u32(n: number): number[] { return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33, 0x44, 0x55];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x66];

function flacWithPicture(mime: string, image: number[]): Blob {
  const mimeBytes = Array.from(new TextEncoder().encode(mime));
  const pic = [
    ...u32(3), ...u32(mimeBytes.length), ...mimeBytes,
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(image.length), ...image,
  ];
  const bytes = [
    0x66, 0x4c, 0x61, 0x43,
    0x00, 0x00, 0x00, 0x22, ...new Array(34).fill(0),                 // STREAMINFO
    0x06, (pic.length >> 16) & 0xff, (pic.length >> 8) & 0xff, pic.length & 0xff, ...pic,
    0x81, 0x00, 0x00, 0x04, 0, 0, 0, 0,                               // PADDING (last)
    0xff, 0xf8, 0x01, 0x02,                                           // fake audio
  ];
  return new Blob([new Uint8Array(bytes)], { type: "audio/flac" });
}

function mp3WithApic(mime: string, image: number[]): Blob {
  const mimeBytes = Array.from(new TextEncoder().encode(mime));
  const body = [0x00, ...mimeBytes, 0x00, 0x03, 0x00, ...image]; // latin1 enc, empty desc
  const frame = [0x41, 0x50, 0x49, 0x43, ...u32(body.length), 0x00, 0x00, ...body]; // "APIC"
  const tagSize = frame.length + 16; // + padding
  const ss = [(tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f];
  const bytes = [
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, ...ss,  // "ID3" v2.3
    ...frame, ...new Array(16).fill(0),
    0xff, 0xfb, 0x90, 0x00,                      // fake mpeg frame
  ];
  return new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
}

async function firstBytes(blob: Blob, n: number): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.slice(0, n).arrayBuffer()));
}

async function main() {
  console.log("FLAC PICTURE with declared mime");
  {
    const pic = await extractEmbeddedCover(flacWithPicture("image/jpeg", JPEG));
    assert(pic !== null, "extracted");
    assert(pic!.type === "image/jpeg", `type=${pic!.type}`);
    assert(JSON.stringify(await firstBytes(pic!, 4)) === JSON.stringify(JPEG.slice(0, 4)), "payload bytes match");
  }

  console.log("FLAC PICTURE with empty mime sniffs from magic");
  {
    const pic = await extractEmbeddedCover(flacWithPicture("", PNG));
    assert(pic !== null, "extracted");
    assert(pic!.type === "image/png", `type=${pic!.type}`);
  }

  console.log("ID3v2.3 APIC extraction");
  {
    const pic = await extractEmbeddedCover(mp3WithApic("image/jpeg", JPEG));
    assert(pic !== null, "extracted");
    assert(pic!.type === "image/jpeg", `type=${pic!.type}`);
    assert(pic!.size === JPEG.length, `size=${pic!.size}`);
    assert(JSON.stringify(await firstBytes(pic!, 4)) === JSON.stringify(JPEG.slice(0, 4)), "payload bytes match");
  }

  console.log("files without art / non-audio return null");
  {
    const noPicFlac = new Blob([new Uint8Array([
      0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22, ...new Array(34).fill(0),
    ])], { type: "audio/flac" });
    assert((await extractEmbeddedCover(noPicFlac)) === null, "FLAC without PICTURE → null");
    assert((await extractEmbeddedCover(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])]))) === null, "random bytes → null");
    assert((await extractEmbeddedCover(new Blob([]))) === null, "empty blob → null");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("UNCAUGHT", e); process.exit(2); });
