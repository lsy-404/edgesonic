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

// Some third-party taggers write FLAC PICTURE metadata blocks with an empty
// MIME string (length 0). Chrome's FFmpeg demuxer treats that as fatal and
// refuses to open the whole file, even though the audio itself is fine. The
// page cannot relax the demuxer, so this repairs the blob in memory before it
// is handed to <audio>: insert a MIME sniffed from the image magic and grow
// the block length accordingly. FLAC SEEKTABLE offsets are relative to the
// first audio frame, so growing the metadata region does not break seeking.
//
// All reads go through Blob.slice, so only block headers and a few prefix
// bytes are materialized — the (potentially huge) picture payload and audio
// are stitched back by reference.

const PICTURE = 6;
const MAX_BLOCKS = 128;

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function sniffImageMime(magic: Uint8Array): string {
  if (magic.length >= 2 && magic[0] === 0x89 && magic[1] === 0x50) return "image/png";
  // JPEG (ffd8) and anything unrecognized: image/jpeg is what taggers write
  // for the overwhelming majority of embedded covers, and the demuxer only
  // needs a syntactically valid, known MIME to proceed.
  return "image/jpeg";
}

/**
 * Returns a repaired copy when the blob is a FLAC whose PICTURE block(s)
 * carry an empty MIME string, or null when no repair is needed or the
 * structure cannot be parsed safely (in which case the caller should use
 * the original blob untouched).
 */
export async function repairFlacPictureMime(blob: Blob): Promise<Blob | null> {
  const head = await bytes(blob, 0, 4);
  if (head.length < 4 || head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) {
    return null;
  }

  const parts: BlobPart[] = [blob.slice(0, 4)];
  let off = 4;
  let repaired = false;

  for (let guard = 0; guard < MAX_BLOCKS; guard++) {
    const hdr = await bytes(blob, off, off + 4);
    if (hdr.length < 4) return null; // truncated metadata — leave untouched
    const lastFlag = (hdr[0] & 0x80) !== 0;
    const blockType = hdr[0] & 0x7f;
    const len = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    const bodyOff = off + 4;
    if (bodyOff + len > blob.size) return null; // corrupt length — leave untouched

    let handled = false;
    if (blockType === PICTURE && len >= 8) {
      const pfx = await bytes(blob, bodyOff, bodyOff + 12);
      const mimeLen = (pfx[4] << 24) | (pfx[5] << 16) | (pfx[6] << 8) | pfx[7];
      if (mimeLen === 0) {
        // Layout with empty MIME: picType(4) mimeLen(4) descLen(4) desc
        // colour-info(16) dataLen(4) data…  — locate the payload to sniff it.
        const descLen = (pfx[8] << 24) | (pfx[9] << 16) | (pfx[10] << 8) | pfx[11];
        const dataOff = bodyOff + 12 + descLen + 16 + 4;
        const magic = await bytes(blob, dataOff, dataOff + 4);
        // Uint8Array.from pins the backing store to a plain ArrayBuffer so the
        // element satisfies BlobPart under the DOM lib's stricter generics.
        const mime = Uint8Array.from(new TextEncoder().encode(sniffImageMime(magic)));

        const newLen = len + mime.length;
        if (newLen > 0xffffff) return null; // 24-bit block length would overflow
        parts.push(
          new Uint8Array([(lastFlag ? 0x80 : 0) | PICTURE, (newLen >> 16) & 0xff, (newLen >> 8) & 0xff, newLen & 0xff]),
          blob.slice(bodyOff, bodyOff + 4),
          new Uint8Array([0, 0, 0, mime.length]),
          mime,
          blob.slice(bodyOff + 8, bodyOff + len),
        );
        repaired = true;
        handled = true;
      }
    }
    if (!handled) parts.push(blob.slice(off, bodyOff + len));

    off = bodyOff + len;
    if (lastFlag) {
      if (!repaired) return null;
      parts.push(blob.slice(off));
      return new Blob(parts, { type: blob.type || "audio/flac" });
    }
  }
  return null; // block chain never terminated — leave untouched
}
