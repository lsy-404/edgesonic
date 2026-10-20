// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data-segment fingerprints: a hash of the audio payload that ignores tags,
// so two copies of the same recording compare equal after retagging.
//
//  - FLAC stores the MD5 of its unencoded samples in STREAMINFO; reading the
//    first block is enough.
//  - Integer 16/24-bit WAV keeps those same samples, little-endian and
//    interleaved, in its data chunk, so MD5(data) equals the FLAC signature
//    of a lossless conversion. Both are reported as `pcm`.
//  - MP3 hashes the frame region between ID3v2 and trailing ID3v1/APE tags.
//  - Other containers fall back to hashing the whole file.
//
// Stored form: `v1:<kind>:<md5>:<objectSize>`. Comparison uses kind and md5;
// the size only marks a cached value stale when the object was rewritten.

export type AudioSegment =
  | { kind: "pcm"; md5: string }
  | { kind: "pcm" | "wavdata" | "mp3" | "file"; start: number; end: number };

export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

const WAV_SCAN_LIMIT = 256;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = offset; i < offset + length && i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Length of a leading ID3v2 tag including its header and optional footer.
function id3v2Length(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== "ID3") return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  return 10 + size + ((head[5] & 0x10) ? 10 : 0);
}

async function flacSegment(read: RangeReader, size: number): Promise<AudioSegment | null> {
  const offset = id3v2Length(await read(0, Math.min(size, 10)));
  const head = await read(offset, 42);
  if (ascii(head, 0, 4) !== "fLaC" || (head[4] & 0x7f) !== 0) return null;
  const md5 = head.subarray(26, 42);
  // An all-zero signature means the encoder skipped it; nothing to compare.
  if (md5.length !== 16 || md5.every((byte) => byte === 0)) return null;
  return { kind: "pcm", md5: hex(md5) };
}

async function wavSegment(read: RangeReader, size: number): Promise<AudioSegment | null> {
  const prefix = await read(0, Math.min(size, 65536));
  if (ascii(prefix, 0, 4) !== "RIFF" || ascii(prefix, 8, 4) !== "WAVE") return null;
  const header = async (offset: number, length: number) =>
    offset + length <= prefix.length ? prefix.subarray(offset, offset + length) : read(offset, length);

  let integerPcm = false;
  let offset = 12;
  for (let i = 0; i < WAV_SCAN_LIMIT && offset + 8 <= size; i++) {
    const chunk = await header(offset, 8);
    const id = ascii(chunk, 0, 4);
    const length = u32le(chunk, 4);
    if (id === "fmt ") {
      const fmt = await header(offset + 8, Math.min(length, 40));
      let format = u16le(fmt, 0);
      if (format === 0xfffe && fmt.length >= 26) format = u16le(fmt, 24);
      const bits = u16le(fmt, 14);
      const blockAlign = u16le(fmt, 12);
      const channels = u16le(fmt, 2);
      integerPcm = format === 1 && (bits === 16 || bits === 24) && blockAlign === channels * (bits / 8);
    } else if (id === "data") {
      const start = offset + 8;
      const end = Math.min(start + length, size);
      return end > start ? { kind: integerPcm ? "pcm" : "wavdata", start, end } : null;
    }
    offset += 8 + length + (length & 1);
  }
  return null;
}

async function mp3Segment(read: RangeReader, size: number): Promise<AudioSegment | null> {
  const start = id3v2Length(await read(0, Math.min(size, 10)));
  let end = size;
  const tailLength = Math.min(size, 160);
  const tail = await read(size - tailLength, tailLength);
  if (tailLength >= 128 && ascii(tail, tailLength - 128, 3) === "TAG") end -= 128;
  const footerAt = tailLength - (size - end) - 32;
  if (footerAt >= 0 && ascii(tail, footerAt, 8) === "APETAGEX") {
    const tagSize = u32le(tail, footerAt + 12);
    const hasHeader = (u32le(tail, footerAt + 20) & 0x80000000) !== 0;
    end -= tagSize + (hasHeader ? 32 : 0);
  }
  return end > start ? { kind: "mp3", start, end } : null;
}

export async function locateAudioSegment(read: RangeReader, suffix: string, size: number): Promise<AudioSegment | null> {
  if (size <= 0) return null;
  switch (suffix.toLowerCase()) {
    case "flac": return flacSegment(read, size);
    case "wav": return wavSegment(read, size);
    case "mp3": return mp3Segment(read, size);
    default: return { kind: "file", start: 0, end: size };
  }
}

export async function fingerprintR2Object(bucket: R2Bucket, key: string, suffix: string): Promise<string | null> {
  const head = await bucket.head(key);
  if (!head) return null;
  const read: RangeReader = async (offset, length) => {
    if (length <= 0) return new Uint8Array(0);
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object) throw new Error("Object disappeared while reading");
    return new Uint8Array(await object.arrayBuffer());
  };
  const segment = await locateAudioSegment(read, suffix, head.size);
  if (!segment) return null;
  if ("md5" in segment) return `v1:${segment.kind}:${segment.md5}:${head.size}`;

  const object = await bucket.get(key, { range: { offset: segment.start, length: segment.end - segment.start } });
  if (!object) return null;
  const digest = new crypto.DigestStream("MD5");
  await object.body.pipeTo(digest);
  return `v1:${segment.kind}:${hex(new Uint8Array(await digest.digest))}:${head.size}`;
}

export interface ParsedFingerprint {
  identity: string;
  size: number;
}

export function parseFingerprint(value: string | null | undefined): ParsedFingerprint | null {
  const match = /^v1:([a-z]+):([0-9a-f]{32}):(\d+)$/.exec(value ?? "");
  return match ? { identity: `${match[1]}:${match[2]}`, size: Number(match[3]) } : null;
}
