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

// Embedded artwork rarely declares a usable media type: ID3v2.3 permits the
// bare format strings "PNG"/"JPG", taggers write "-->" for link frames, and
// some leave the field empty. Serving those verbatim gives clients a media
// type they refuse to render, so every cover is typed from its own bytes and
// the declared value is honoured only when it is already a real image type.

const IMAGE_MIME = /^image\/(jpeg|png|gif|webp|bmp|avif|tiff)$/i;

/** Media type implied by the leading bytes, or null when unrecognised. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66) return "image/avif";
  return null;
}

/** True when a stored/declared value can be served to a client as-is. */
export function isUsableImageMime(mime: string | null | undefined): boolean {
  return !!mime && IMAGE_MIME.test(mime.trim());
}

/**
 * Media type to serve for these bytes: the sniffed type wins, the declared
 * one is the fallback when it is already valid, and JPEG closes the gap for
 * artwork we cannot identify (rather than an empty or bogus header).
 */
export function resolveImageMime(declared: string | null | undefined, bytes: Uint8Array): string {
  return sniffImageMime(bytes) ?? (isUsableImageMime(declared) ? declared!.trim() : "image/jpeg");
}
