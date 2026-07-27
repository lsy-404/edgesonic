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

// In-memory repair of FLAC PICTURE blocks with an empty MIME string — the
// pattern Chrome's demuxer rejects wholesale. Builds synthetic FLACs and
// asserts the repaired byte stream block-by-block.
//
// Run: npx tsx test/frontend/flac_picture_mime_repair.test.ts
import { repairFlacPictureMime } from "../../web/src/lib/flacRepair";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function u32(n: number): number[] { return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
function blockHeader(type: number, len: number, last = false): number[] {
  return [(last ? 0x80 : 0) | type, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
}

// PICTURE body: picType(4) mimeLen(4) mime descLen(4) desc colour(16) dataLen(4) data
function pictureBody(mime: string, imageData: number[]): number[] {
  const mimeBytes = Array.from(new TextEncoder().encode(mime));
  return [
    ...u32(3),
    ...u32(mimeBytes.length), ...mimeBytes,
    ...u32(0),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(imageData.length), ...imageData,
  ];
}

const JPEG_DATA = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];
const PNG_DATA = [0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8];
const AUDIO = [0xff, 0xf8, 0xaa, 0xbb, 0xcc]; // stand-in audio frames

function buildFlac(pictureMime: string | null, imageData: number[]): Blob {
  const streaminfo = new Array(34).fill(0);
  const pic = pictureBody(pictureMime ?? "", imageData);
  const bytes = [
    0x66, 0x4c, 0x61, 0x43,
    ...blockHeader(0, streaminfo.length), ...streaminfo,
    ...blockHeader(6, pic.length),        ...pic,
    ...blockHeader(1, 8, true),           ...new Array(8).fill(0),
    ...AUDIO,
  ];
  return new Blob([new Uint8Array(bytes)], { type: "audio/flac" });
}

async function parsePictureMime(blob: Blob): Promise<{ mime: string; audioTail: number[] }> {
  const data = new Uint8Array(await blob.arrayBuffer());
  let off = 4;
  let mime = "";
  for (;;) {
    const last = (data[off] & 0x80) !== 0;
    const type = data[off] & 0x7f;
    const len = (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];
    if (type === 6) {
      const mimeLen = (data[off + 8] << 24) | (data[off + 9] << 16) | (data[off + 10] << 8) | data[off + 11];
      mime = new TextDecoder().decode(data.slice(off + 12, off + 12 + mimeLen));
    }
    off += 4 + len;
    if (last) break;
  }
  return { mime, audioTail: Array.from(data.slice(data.length - AUDIO.length)) };
}

async function main() {
  console.log("empty-MIME jpeg picture gets image/jpeg inserted");
  {
    const broken = buildFlac(null, JPEG_DATA);
    const repaired = await repairFlacPictureMime(broken);
    assert(repaired !== null, "repair returned a blob");
    assert(repaired!.size === broken.size + "image/jpeg".length, "size grew by mime length");
    const { mime, audioTail } = await parsePictureMime(repaired!);
    assert(mime === "image/jpeg", `mime=${mime}`);
    assert(JSON.stringify(audioTail) === JSON.stringify(AUDIO), "audio bytes untouched");
  }

  console.log("empty-MIME png picture gets image/png inserted");
  {
    const repaired = await repairFlacPictureMime(buildFlac(null, PNG_DATA));
    assert(repaired !== null, "repair returned a blob");
    const { mime } = await parsePictureMime(repaired!);
    assert(mime === "image/png", `mime=${mime}`);
  }

  console.log("healthy picture is left untouched");
  {
    const repaired = await repairFlacPictureMime(buildFlac("image/jpeg", JPEG_DATA));
    assert(repaired === null, "no repair for valid mime");
  }

  console.log("non-FLAC and corrupt inputs are left untouched");
  {
    assert((await repairFlacPictureMime(new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "audio/flac" }))) === null, "not a fLaC stream");
    // Corrupt: block length pointing beyond EOF.
    const bad = new Blob([new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...blockHeader(0, 9999), 0, 0])], { type: "audio/flac" });
    assert((await repairFlacPictureMime(bad)) === null, "oversized block length bails out");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("UNCAUGHT", e); process.exit(2); });
