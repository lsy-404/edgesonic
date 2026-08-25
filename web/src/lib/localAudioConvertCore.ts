// SPDX-License-Identifier: AGPL-3.0-or-later
// File-level adapters use the MIT/Apache-2.0 Unlock Music crypto core.

import {
  KWMDecipher,
  KuGou,
  KuGouHeader,
  KuwoHeader,
  Migu3D,
  NCMFile,
  QMC2,
  QMCFooter,
  Xiami,
  XmlyPC,
  decryptQMC1,
  decryptX2MHeader,
  decryptX3MHeader,
  ready as cryptoReady,
} from "@clamber_l/crypto/inline";
import type { LocalAudioConversionErrorCode } from "./localAudioConvertTypes";

export class LocalAudioConversionError extends Error {
  constructor(public readonly code: LocalAudioConversionErrorCode, message: string) {
    super(message);
    this.name = "LocalAudioConversionError";
  }
}

export interface ConvertedAudioBytes {
  data: Uint8Array;
  extension: string;
  mimeType: string;
  cipher: string;
}

export type ConversionProgress = (percent: number) => void;

const MIME_TYPES: Record<string, string> = {
  aac: "audio/aac",
  aiff: "audio/aiff",
  ape: "audio/ape",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  wma: "audio/x-ms-wma",
};

const QMC1_EXTENSIONS = new Set([
  "qmc0", "qmc2", "qmc3", "qmc4", "qmc6", "qmc8", "tkm",
  "bkcmp3", "bkcm4a", "bkcflac", "bkcwav", "bkcape", "bkcogg", "bkcwma",
  "666c6163", "6d7033", "6f6767", "6d3461", "776176",
]);
const QMC2_EXTENSIONS = new Set([
  "qmcflac", "qmcogg", "mggl", "mflac", "mflac0", "mflach",
  "mgg", "mgg0", "mgg1", "mmp4",
]);

function startsWith(data: Uint8Array, bytes: number[], offset = 0) {
  return bytes.every((value, index) => data[offset + index] === value);
}

export function sniffAudioExtension(data: Uint8Array): string | null {
  if (startsWith(data, [0x66, 0x4c, 0x61, 0x43])) return "flac";
  if (startsWith(data, [0x4f, 0x67, 0x67, 0x53])) {
    const head = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 128)));
    return head.includes("OpusHead") ? "opus" : "ogg";
  }
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x41, 0x56, 0x45], 8)) return "wav";
  if (startsWith(data, [0x46, 0x4f, 0x52, 0x4d]) && (startsWith(data, [0x41, 0x49, 0x46, 0x46], 8) || startsWith(data, [0x41, 0x49, 0x46, 0x43], 8))) return "aiff";
  if (startsWith(data, [0x4d, 0x41, 0x43, 0x20])) return "ape";
  if (startsWith(data, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return "wma";
  if (startsWith(data, [0x49, 0x44, 0x33]) || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return "mp3";
  if (data.length >= 12 && startsWith(data, [0x66, 0x74, 0x79, 0x70], 4)) return "m4a";
  if (startsWith(data, [0x41, 0x44, 0x49, 0x46]) || (data[0] === 0xff && (data[1] & 0xf6) === 0xf0)) return "aac";
  return null;
}

function finish(data: Uint8Array, cipher: string): ConvertedAudioBytes {
  const extension = sniffAudioExtension(data);
  if (!extension) throw new LocalAudioConversionError("invalid_file", "converted bytes are not a recognized audio stream");
  return { data, extension, mimeType: MIME_TYPES[extension] || "application/octet-stream", cipher };
}

function chunks(data: Uint8Array, callback: (block: Uint8Array, offset: number) => void, onProgress?: ConversionProgress) {
  const blockSize = 64 * 1024;
  for (let offset = 0; offset < data.length; offset += blockSize) {
    callback(data.subarray(offset, Math.min(offset + blockSize, data.length)), offset);
    onProgress?.(Math.min(98, Math.round(((offset + blockSize) / Math.max(1, data.length)) * 95)));
  }
}

function decryptNcm(source: Uint8Array, onProgress?: ConversionProgress) {
  const ncm = new NCMFile();
  try {
    let required = Math.min(1024, source.length);
    while (required !== 0) {
      const available = Math.min(required, source.length);
      const next = ncm.open(source.subarray(0, available));
      if (next === -1) throw new LocalAudioConversionError("invalid_file", "not an NCM file");
      if (next > source.length || (next > available && available === source.length)) {
        throw new LocalAudioConversionError("invalid_file", "truncated NCM header");
      }
      required = next;
    }
    if (ncm.audioOffset < 0 || ncm.audioOffset >= source.length) {
      throw new LocalAudioConversionError("invalid_file", "invalid NCM audio offset");
    }
    const audio = source.slice(ncm.audioOffset);
    chunks(audio, (block, offset) => ncm.decrypt(block, offset), onProgress);
    return finish(audio, "NCM");
  } finally {
    ncm.free();
  }
}

function decryptQmc1(source: Uint8Array, onProgress?: ConversionProgress) {
  const probe = source.slice(0, Math.min(4096, source.length));
  decryptQMC1(probe, 0);
  if (!sniffAudioExtension(probe)) throw new LocalAudioConversionError("invalid_file", "not a QMCv1 file");
  const audio = source.slice();
  chunks(audio, (block, offset) => decryptQMC1(block, offset), onProgress);
  return finish(audio, "QMCv1");
}

function decryptQmc2(source: Uint8Array, onProgress?: ConversionProgress) {
  const footer = QMCFooter.parse(source.subarray(Math.max(0, source.length - 1024)));
  if (!footer) throw new LocalAudioConversionError("invalid_file", "QMCv2 footer is missing");
  let footerSize = 0;
  let ekey: string | undefined;
  try {
    footerSize = footer.size;
    ekey = footer.ekey;
  } finally {
    footer.free();
  }
  if (!ekey) throw new LocalAudioConversionError("missing_key", "QMCv2 file has no embedded eKey");
  if (footerSize <= 0 || footerSize >= source.length) throw new LocalAudioConversionError("invalid_file", "invalid QMCv2 footer size");
  const audio = source.slice(0, source.length - footerSize);
  const qmc = new QMC2(ekey);
  try {
    chunks(audio, (block, offset) => qmc.decrypt(block, offset), onProgress);
  } finally {
    qmc.free();
  }
  return finish(audio, "QMCv2");
}

function decryptKuwo(source: Uint8Array, onProgress?: ConversionProgress) {
  if (source.length <= 0x400) throw new LocalAudioConversionError("invalid_file", "truncated KWM file");
  const header = KuwoHeader.parse(source.subarray(0, 0x400));
  const decipher = new KWMDecipher(header);
  try {
    const audio = source.slice(0x400);
    chunks(audio, (block, offset) => decipher.decrypt(block, offset), onProgress);
    return finish(audio, "KWM");
  } finally {
    decipher.free();
    header.free();
  }
}

function decryptKugou(source: Uint8Array, onProgress?: ConversionProgress) {
  if (source.length <= 0x400) throw new LocalAudioConversionError("invalid_file", "truncated KGM file");
  const headerBytes = source.subarray(0, 0x400);
  const header = new KuGouHeader(headerBytes);
  const audioOffset = header.offsetToData || 0x400;
  let decipher: KuGou | undefined;
  try {
    decipher = header.version >= 5 ? KuGou.fromHeaderV5(header) : KuGou.from_header(headerBytes);
    const audio = source.slice(audioOffset);
    chunks(audio, (block, offset) => decipher?.decrypt(block, offset), onProgress);
    return finish(audio, "KGM");
  } finally {
    decipher?.free();
    header.free();
  }
}

function decryptXiami(source: Uint8Array, onProgress?: ConversionProgress) {
  if (source.length <= 0x10) throw new LocalAudioConversionError("invalid_file", "truncated Xiami file");
  const decipher = Xiami.from_header(source.subarray(0, 0x10));
  try {
    const audio = source.slice(0x10);
    const encrypted = audio.subarray(decipher.copyPlainLength);
    chunks(encrypted, (block) => decipher.decrypt(block), onProgress);
    return finish(audio, "Xiami/XM");
  } finally {
    decipher.free();
  }
}

function decryptXimalayaPc(source: Uint8Array, onProgress?: ConversionProgress) {
  const headerSize = XmlyPC.getHeaderSize(source.subarray(0, Math.min(1024, source.length)));
  const decipher = new XmlyPC(source.subarray(0, headerSize));
  try {
    const plainOffset = decipher.encryptedHeaderOffset + decipher.encryptedHeaderSize;
    const encrypted = source.slice(decipher.encryptedHeaderOffset, plainOffset);
    const decryptedLength = decipher.decrypt(encrypted);
    const result = new Uint8Array(decipher.audioHeader.length + decryptedLength + source.length - plainOffset);
    result.set(decipher.audioHeader, 0);
    result.set(encrypted.subarray(0, decryptedLength), decipher.audioHeader.length);
    result.set(source.subarray(plainOffset), decipher.audioHeader.length + decryptedLength);
    onProgress?.(98);
    return finish(result, "Ximalaya/XM");
  } finally {
    decipher.free();
  }
}

function decryptXimalayaAndroid(source: Uint8Array, version: "x2m" | "x3m", onProgress?: ConversionProgress) {
  if (source.length < 1024) throw new LocalAudioConversionError("invalid_file", `truncated ${version.toUpperCase()} file`);
  const result = source.slice();
  const header = result.slice(0, 1024);
  if (version === "x2m") decryptX2MHeader(header);
  else decryptX3MHeader(header);
  result.set(header, 0);
  onProgress?.(98);
  return finish(result, `Ximalaya/${version.toUpperCase()}`);
}

function decryptMigu(source: Uint8Array, onProgress?: ConversionProgress) {
  const result = source.slice();
  const decipher = Migu3D.fromHeader(result.subarray(0, Math.min(0x100, result.length)));
  try {
    chunks(result, (block, offset) => decipher.decrypt(block, offset), onProgress);
    return finish(result, "Migu/MG3D");
  } finally {
    decipher.free();
  }
}

function decryptNcmCache(source: Uint8Array, onProgress?: ConversionProgress) {
  const result = source.slice();
  chunks(result, (block) => {
    for (let index = 0; index < block.length; index++) block[index] ^= 0xa3;
  }, onProgress);
  return finish(result, "NetEase/cache");
}

function restoreTmHeader(source: Uint8Array) {
  if (source.length < 8) throw new LocalAudioConversionError("invalid_file", "truncated TM file");
  const result = source.slice();
  result.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70], 0);
  return finish(result, "QQMusic/TM");
}

function normalizeConversionError(error: unknown) {
  if (error instanceof LocalAudioConversionError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const code: LocalAudioConversionErrorCode = /(?:e-?key|key|password|credential)/i.test(detail)
    ? "missing_key"
    : "invalid_file";
  return new LocalAudioConversionError(code, detail);
}

function tryCandidates(candidates: Array<() => ConvertedAudioBytes>) {
  const errors: unknown[] = [];
  for (const candidate of candidates) {
    try { return candidate(); } catch (error) { errors.push(error); }
  }
  const missingKey = errors.find((error) => error instanceof LocalAudioConversionError && error.code === "missing_key");
  if (missingKey) throw missingKey;
  throw new LocalAudioConversionError("invalid_file", errors.map((error) => error instanceof Error ? error.message : String(error)).join("; "));
}

function convertEncryptedBytesReady(extension: string, source: Uint8Array, onProgress?: ConversionProgress) {
  const ext = extension.replace(/^\./, "").toLowerCase();
  onProgress?.(1);
  if (ext === "ncm") return decryptNcm(source, onProgress);
  if (ext === "uc") return decryptNcmCache(source, onProgress);
  if (ext === "cache") return tryCandidates([() => decryptNcmCache(source, onProgress), () => decryptQmc1(source, onProgress)]);
  if (ext === "kwm") return decryptKuwo(source, onProgress);
  if (ext === "kgm" || ext === "kgma" || ext === "vpr") return decryptKugou(source, onProgress);
  if (ext === "xm") return tryCandidates([() => decryptXimalayaPc(source, onProgress), () => decryptXiami(source, onProgress)]);
  if (ext === "x2m" || ext === "x3m") return decryptXimalayaAndroid(source, ext, onProgress);
  if (ext === "mg3d") return decryptMigu(source, onProgress);
  if (["tm0", "tm2", "tm3", "tm6"].includes(ext)) return restoreTmHeader(source);
  if (QMC1_EXTENSIONS.has(ext)) return decryptQmc1(source, onProgress);
  if (QMC2_EXTENSIONS.has(ext)) return tryCandidates([() => decryptQmc2(source, onProgress), () => decryptQmc1(source, onProgress)]);
  throw new LocalAudioConversionError("unsupported_format", `unsupported encrypted extension: ${ext || "unknown"}`);
}

export async function convertEncryptedBytes(extension: string, source: Uint8Array, onProgress?: ConversionProgress): Promise<ConvertedAudioBytes> {
  await cryptoReady;
  try {
    return convertEncryptedBytesReady(extension, source, onProgress);
  } catch (error) {
    throw normalizeConversionError(error);
  }
}
