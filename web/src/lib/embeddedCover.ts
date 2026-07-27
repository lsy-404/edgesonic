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

// Client-side embedded-cover extraction. When getCoverArt 404s (the server
// only resolves embedded art, and only from a bounded head slice), the player
// usually already holds the complete audio bytes in its buffer — so look
// inside the song file itself for a cover: FLAC PICTURE blocks and ID3v2
// APIC frames. Everything reads via Blob.slice; only headers and the picture
// payload are materialized. Any structural surprise returns null — this is a
// best-effort fallback, never an error source.

const FLAC_PICTURE = 6;
const MAX_BLOCKS = 128;
const MAX_ID3_FRAMES = 512;

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function sniffImageMime(magic: Uint8Array): string {
  if (magic.length >= 2 && magic[0] === 0x89 && magic[1] === 0x50) return "image/png";
  return "image/jpeg";
}

async function pictureBlob(blob: Blob, dataOff: number, dataLen: number, declaredMime: string): Promise<Blob | null> {
  if (dataLen <= 0 || dataOff + dataLen > blob.size) return null;
  const magic = await bytes(blob, dataOff, dataOff + 4);
  const mime = /^image\//.test(declaredMime) ? declaredMime : sniffImageMime(magic);
  return blob.slice(dataOff, dataOff + dataLen, mime);
}

async function fromFlac(blob: Blob): Promise<Blob | null> {
  let off = 4;
  for (let guard = 0; guard < MAX_BLOCKS; guard++) {
    const hdr = await bytes(blob, off, off + 4);
    if (hdr.length < 4) return null;
    const lastFlag = (hdr[0] & 0x80) !== 0;
    const blockType = hdr[0] & 0x7f;
    const len = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    const bodyOff = off + 4;
    if (bodyOff + len > blob.size) return null;

    if (blockType === FLAC_PICTURE && len >= 32) {
      // picType(4) mimeLen(4) mime descLen(4) desc colour(16) dataLen(4) data
      const pfx = await bytes(blob, bodyOff, bodyOff + 8);
      const mimeLen = (pfx[4] << 24) | (pfx[5] << 16) | (pfx[6] << 8) | pfx[7];
      if (mimeLen >= 0 && mimeLen < 256) {
        const mimeBytes = await bytes(blob, bodyOff + 8, bodyOff + 8 + mimeLen);
        const declaredMime = new TextDecoder("latin1").decode(mimeBytes);
        let p = bodyOff + 8 + mimeLen;
        const descHdr = await bytes(blob, p, p + 4);
        const descLen = (descHdr[0] << 24) | (descHdr[1] << 16) | (descHdr[2] << 8) | descHdr[3];
        p += 4 + descLen + 16;
        const dataHdr = await bytes(blob, p, p + 4);
        if (dataHdr.length < 4) return null;
        const dataLen = (dataHdr[0] << 24) | (dataHdr[1] << 16) | (dataHdr[2] << 8) | dataHdr[3];
        const pic = await pictureBlob(blob, p + 4, dataLen, declaredMime);
        if (pic) return pic;
      }
    }
    off = bodyOff + len;
    if (lastFlag) return null;
  }
  return null;
}

function syncsafe(b: Uint8Array, off: number): number {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f);
}

async function fromId3(blob: Blob): Promise<Blob | null> {
  const head = await bytes(blob, 0, 10);
  const major = head[3];
  if (major !== 3 && major !== 4) return null;
  const flags = head[5];
  if (flags & 0x80) return null; // unsynchronised tag — too exotic for a fallback
  const tagSize = syncsafe(head, 6);
  let off = 10;
  if (flags & 0x40) {
    // Extended header: size field counts differently across versions; both
    // store the total to skip in the first 4 bytes.
    const ext = await bytes(blob, off, off + 4);
    off += major === 4 ? syncsafe(ext, 0) : 4 + ((ext[0] << 24) | (ext[1] << 16) | (ext[2] << 8) | ext[3]);
  }
  const end = Math.min(10 + tagSize, blob.size);

  for (let guard = 0; guard < MAX_ID3_FRAMES && off + 10 <= end; guard++) {
    const fh = await bytes(blob, off, off + 10);
    if (fh[0] === 0) return null; // padding reached
    const id = String.fromCharCode(fh[0], fh[1], fh[2], fh[3]);
    const size = major === 4 ? syncsafe(fh, 4) : (fh[4] << 24) | (fh[5] << 16) | (fh[6] << 8) | fh[7];
    if (size <= 0 || off + 10 + size > end + 1) return null;
    const bodyOff = off + 10;

    if (id === "APIC") {
      // encoding(1) mime\0 picType(1) description\0(enc-dependent) data
      const probe = await bytes(blob, bodyOff, Math.min(bodyOff + 512, bodyOff + size));
      const encoding = probe[0];
      let p = 1;
      while (p < probe.length && probe[p] !== 0) p++;
      const declaredMime = new TextDecoder("latin1").decode(probe.slice(1, p));
      p++; // mime terminator
      p++; // picture type
      if (encoding === 1 || encoding === 2) {
        // UTF-16 description: terminated by 00 00 (aligned pairs).
        while (p + 1 < probe.length && !(probe[p] === 0 && probe[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        while (p < probe.length && probe[p] !== 0) p++;
        p++;
      }
      if (p >= probe.length) return null; // description exceeded probe window — bail
      const pic = await pictureBlob(blob, bodyOff + p, size - p, declaredMime);
      if (pic) return pic;
    }
    off = bodyOff + size;
  }
  return null;
}

/** Extract the first embedded cover image, or null when none can be found. */
export async function extractEmbeddedCover(blob: Blob): Promise<Blob | null> {
  try {
    const head = await bytes(blob, 0, 4);
    if (head.length < 4) return null;
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) return await fromFlac(blob);
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return await fromId3(blob);
    return null;
  } catch {
    return null;
  }
}
