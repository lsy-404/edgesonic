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

// Cover media types are decided from the artwork bytes because embedded tags
// declare values clients cannot use ("PNG", "-->", empty).
//
// Run: npx tsx test/internal/image_type.test.ts
import { sniffImageMime, isUsableImageMime, resolveImageMime } from "../../worker/src/utils/imageType";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const BMP = new Uint8Array([0x42, 0x4d, 1, 2, 3, 4]);

function main() {
  console.log("magic bytes decide the type:");
  {
    assert(sniffImageMime(JPEG) === "image/jpeg", "jpeg");
    assert(sniffImageMime(PNG) === "image/png", "png");
    assert(sniffImageMime(GIF) === "image/gif", "gif");
    assert(sniffImageMime(WEBP) === "image/webp", "webp");
    assert(sniffImageMime(BMP) === "image/bmp", "bmp");
    assert(sniffImageMime(new Uint8Array([1, 2, 3, 4])) === null, "unknown bytes yield nothing");
    assert(sniffImageMime(new Uint8Array()) === null, "empty input is safe");
  }

  console.log("only real image types are servable as-is:");
  {
    assert(isUsableImageMime("image/jpeg"), "image/jpeg accepted");
    assert(isUsableImageMime("IMAGE/PNG"), "case-insensitive");
    assert(!isUsableImageMime("PNG"), "bare ID3v2.3 format string rejected");
    assert(!isUsableImageMime("-->"), "link-frame marker rejected");
    assert(!isUsableImageMime(""), "empty rejected");
    assert(!isUsableImageMime(null), "missing rejected");
    assert(!isUsableImageMime("application/octet-stream"), "non-image rejected");
  }

  console.log("resolution prefers the bytes, then a valid declaration:");
  {
    assert(resolveImageMime("PNG", JPEG) === "image/jpeg", "bogus declaration loses to jpeg bytes");
    assert(resolveImageMime("image/jpeg", PNG) === "image/png", "mislabelled png is corrected");
    assert(resolveImageMime("", PNG) === "image/png", "empty declaration is filled in");
    assert(resolveImageMime("image/webp", new Uint8Array([9, 9, 9])) === "image/webp",
      "unrecognised bytes keep a valid declaration");
    assert(resolveImageMime("-->", new Uint8Array([9, 9, 9])) === "image/jpeg",
      "unrecognised bytes with a bogus declaration fall back to jpeg");
    assert(resolveImageMime("  image/png  ", new Uint8Array([9, 9, 9])) === "image/png", "declaration is trimmed");
    // The case seen in the wild: a PNG cover stored as image/jpeg because the
    // tag said so — plausible enough to pass a validity check, still undecodable.
    assert(resolveImageMime("image/jpeg", PNG) === "image/png", "a valid but wrong declaration loses to the bytes");
    assert(resolveImageMime("image/png", JPEG) === "image/jpeg", "and the reverse");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
