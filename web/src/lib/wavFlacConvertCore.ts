// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseBuffer } from "music-metadata";

export interface WavPcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
}

export class WavFlacConversionError extends Error {
  constructor(public readonly code: "invalid_wav" | "unsupported_wav" | "metadata_loss" | "conversion_failed", message: string) {
    super(message);
    this.name = "WavFlacConversionError";
  }
}

export function copyForTransfer(bytes: Uint8Array) {
  return bytes.slice();
}

function fourCC(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function inspectIntegerPcmWav(bytes: Uint8Array): WavPcmFormat {
  if (bytes.length < 44 || fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "WAVE") {
    throw new WavFlacConversionError("invalid_wav", "The file is not a complete RIFF/WAVE file.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd !== bytes.length) throw new WavFlacConversionError("invalid_wav", "The RIFF size does not match the file length.");
  let offset = 12;
  let formatTag: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let containerBitsPerSample = 0;
  let dataBytes = 0;
  while (offset + 8 <= riffEnd) {
    const id = fourCC(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > riffEnd) throw new WavFlacConversionError("invalid_wav", `The ${id} chunk is truncated.`);
    if (id === "fmt ") {
      if (size < 16) throw new WavFlacConversionError("invalid_wav", "The WAV format chunk is incomplete.");
      formatTag = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      blockAlign = view.getUint16(start + 12, true);
      containerBitsPerSample = view.getUint16(start + 14, true);
      bitsPerSample = containerBitsPerSample;
      if (formatTag === 0xfffe) {
        if (size < 40 || view.getUint16(start + 16, true) < 22) {
          throw new WavFlacConversionError("invalid_wav", "The extensible WAV format chunk is incomplete.");
        }
        const subFormat = new Uint8Array(bytes.buffer, bytes.byteOffset + start + 24, 16);
        const pcmGuid = [1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        formatTag = subFormat.every((value, index) => value === pcmGuid[index]) ? 1 : 0;
        const validBits = view.getUint16(start + 18, true);
        if (validBits > 0) bitsPerSample = validBits;
      }
    } else if (id === "data") {
      dataBytes += size;
    } else if (id === "LIST" && (size < 4 || fourCC(bytes, start) !== "INFO")) {
      throw new WavFlacConversionError("metadata_loss", "This WAV LIST chunk cannot be preserved safely.");
    } else if (!["LIST", "ID3 ", "id3 ", "JUNK", "PAD "].includes(id)) {
      throw new WavFlacConversionError("metadata_loss", `The ${id} WAV chunk cannot be preserved safely.`);
    }
    offset = end + (size & 1);
  }
  if (offset !== riffEnd) throw new WavFlacConversionError("invalid_wav", "The WAV ends inside a chunk header.");
  if (formatTag === null || dataBytes === 0 || !channels || !sampleRate || !blockAlign) {
    throw new WavFlacConversionError("invalid_wav", "The WAV is missing a format or audio data chunk.");
  }
  if (formatTag !== 1) {
    throw new WavFlacConversionError("unsupported_wav", "Only integer PCM WAV files can be represented exactly in FLAC.");
  }
  if (containerBitsPerSample < 4 || containerBitsPerSample > 32 || bitsPerSample < 4 || bitsPerSample > containerBitsPerSample
    || (bitsPerSample > 24 && bitsPerSample !== 32)
    || blockAlign !== channels * Math.ceil(containerBitsPerSample / 8) || dataBytes % blockAlign !== 0) {
    throw new WavFlacConversionError("unsupported_wav", "This PCM bit depth or channel layout cannot be preserved by FLAC.");
  }
  return { sampleRate, channels, bitsPerSample, dataBytes };
}

function stableValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __bytes: Array.from(value) };
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableValue(object[key])]));
  }
  return value ?? null;
}

function stable(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

const COMMON_TAGS = [
  "title", "artists", "artist", "album", "albumartist", "albumartists", "originaldate",
  "track", "disk", "genre", "composer", "lyricist", "writer", "copyright", "publisher",
  "bpm", "compilation", "grouping", "subtitle", "isrc", "barcode", "catalognumber", "movementIndex",
  "movementTotal", "work", "replaygain_track_gain", "replaygain_album_gain",
  "conductor", "remixer", "language",
] as const;

function commentEntries(value: unknown): Array<{ language: string; descriptor: string; text: string }> {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return entries.map((entry) => {
    if (entry && typeof entry === "object" && "text" in entry) {
      const item = entry as { text: unknown; language?: unknown; descriptor?: unknown };
      return { language: String(item.language ?? "").toLowerCase(), descriptor: String(item.descriptor ?? ""), text: String(item.text ?? "") };
    }
    return { language: "", descriptor: "", text: String(entry) };
  }).sort((a, b) => stable(a).localeCompare(stable(b)));
}

interface LyricEntry { language: string; descriptor: string; text: string }

function lyricEntries(commonValue: unknown, nativeTags: Array<{ id: string; value: unknown }>): LyricEntry[] {
  const entries: LyricEntry[] = [];
  const add = (value: unknown, language = "", descriptor = "") => {
    if (value && typeof value === "object" && "text" in value) {
      const item = value as { text: unknown; language?: unknown; descriptor?: unknown };
      entries.push({
        language: String(item.language ?? language).toLowerCase(),
        descriptor: String(item.descriptor ?? descriptor),
        text: String(item.text ?? ""),
      });
    } else if (value !== undefined && value !== null) {
      entries.push({ language: language.toLowerCase(), descriptor, text: String(value) });
    }
  };
  for (const item of Array.isArray(commonValue) ? commonValue : commonValue === undefined ? [] : [commonValue]) add(item);
  for (const tag of nativeTags) {
    const id = tag.id.toUpperCase();
    if (id === "SYLT") {
      throw new WavFlacConversionError("metadata_loss", "Synchronized lyrics cannot be preserved safely.");
    }
    if (id === "USLT" || id === "UNSYNCEDLYRICS" || id === "LYRICS") {
      add(tag.value);
      continue;
    }
    const languageTag = /^LYRICS[-_]([A-Z]{3})$/u.exec(id);
    if (languageTag) add(tag.value, languageTag[1]);
  }
  const unique = new Map(entries.map((entry) => [stable(entry), entry]));
  return [...unique.values()].sort((a, b) => stable(a).localeCompare(stable(b)));
}

function assertDatePreserved(source: Record<string, unknown>, output: Record<string, unknown>) {
  const sourceDate = source.date;
  const sourceYear = source.year;
  const outputDate = output.date;
  const outputYear = output.year;
  if (sourceDate !== undefined && stable(sourceDate) !== stable(outputDate)) {
    throw new WavFlacConversionError("metadata_loss", "The date metadata could not be preserved exactly.");
  }
  if (sourceYear !== undefined && stable(sourceYear) !== stable(outputYear)) {
    throw new WavFlacConversionError("metadata_loss", "The year metadata could not be preserved exactly.");
  }
  if (sourceDate === undefined && outputDate !== undefined &&
      (sourceYear === undefined || String(outputDate) !== String(sourceYear))) {
    throw new WavFlacConversionError("metadata_loss", "The date metadata could not be preserved exactly.");
  }
  if (sourceYear === undefined && outputYear !== undefined) {
    const dateYear = typeof sourceDate === "string" ? /^([0-9]{4})/u.exec(sourceDate)?.[1] : undefined;
    if (!dateYear || String(outputYear) !== dateYear) {
      throw new WavFlacConversionError("metadata_loss", "The year metadata could not be preserved exactly.");
    }
  }
}

function pictureIdentity(value: unknown) {
  const pictures = Array.isArray(value) ? value : [];
  return pictures.map((picture) => {
    const item = picture as { format?: unknown; type?: unknown; description?: unknown; data?: unknown };
    return {
      format: item.format ?? null,
      type: item.type ?? null,
      description: item.description ?? "",
      data: item.data instanceof Uint8Array ? Array.from(item.data) : item.data ?? null,
    };
  });
}

export async function assertMetadataPreserved(source: Uint8Array, output: Uint8Array) {
  const sourceMetadata = await parseBuffer(source, { path: "input.wav" });
  const outputMetadata = await parseBuffer(output, { path: "output.flac" });
  const sourceTags = sourceMetadata.common as unknown as Record<string, unknown>;
  const outputTags = outputMetadata.common as unknown as Record<string, unknown>;
  for (const key of COMMON_TAGS) {
    if (stable(sourceTags[key]) !== stable(outputTags[key])) {
      throw new WavFlacConversionError("metadata_loss", `The ${key} metadata could not be preserved exactly.`);
    }
  }
  const individuallyVerified = new Set(["comment", "lyrics", "picture", "date", "year", "encodedby", "encodersettings"]);
  for (const [key, value] of Object.entries(sourceTags)) {
    if (individuallyVerified.has(key)) continue;
    if (stable(value) !== stable(outputTags[key])) {
      throw new WavFlacConversionError("metadata_loss", `The ${key} metadata could not be preserved exactly.`);
    }
  }
  assertDatePreserved(sourceTags, outputTags);
  const sourceCommentEntries = commentEntries(sourceTags.comment);
  const sourceNative = Object.values(sourceMetadata.native).flat();
  for (const tag of sourceNative) {
    if (tag.id.toUpperCase() !== "COMM") continue;
    const values = Array.isArray(tag.value) ? tag.value : [tag.value];
    for (const value of values) {
      if (value && typeof value === "object") {
        const item = value as { language?: unknown; descriptor?: unknown };
        if (String(item.language ?? "eng").toLowerCase() !== "eng" || String(item.descriptor ?? "") !== "") {
          throw new WavFlacConversionError("metadata_loss", "Comment language or descriptor cannot be preserved safely.");
        }
      }
    }
  }
  const outputComments = commentEntries(outputTags.comment);
  const outputDescriptions = commentEntries(outputTags.description);
  for (const tag of Object.values(outputMetadata.native).flat()) {
    if (tag.id.toUpperCase() === "DESCRIPTION") outputDescriptions.push(...commentEntries(tag.value));
  }
  const outputCommentTexts = [...outputComments, ...outputDescriptions].map((item) => item.text).sort();
  if (stable(sourceCommentEntries.map((item) => item.text).sort()) !== stable(outputCommentTexts)) {
    throw new WavFlacConversionError("metadata_loss", "The comment metadata could not be preserved exactly.");
  }
  const outputNative = Object.values(outputMetadata.native).flat();
  if (stable(lyricEntries(sourceTags.lyrics, sourceNative)) !== stable(lyricEntries(outputTags.lyrics, outputNative))) {
    throw new WavFlacConversionError("metadata_loss", "The lyrics metadata could not be preserved exactly.");
  }
  const sourcePictures = sourceMetadata.common.picture ?? [];
  const outputPictures = outputMetadata.common.picture ?? [];
  if (stable(pictureIdentity(sourcePictures)) !== stable(pictureIdentity(outputPictures))) {
    throw new WavFlacConversionError("metadata_loss", "Embedded cover art could not be preserved exactly.");
  }
  if (stable(sourceMetadata.format.chapters) !== stable(outputMetadata.format.chapters)) {
    throw new WavFlacConversionError("metadata_loss", "Chapter metadata could not be preserved exactly.");
  }
  for (const tag of sourceNative) {
    const id = tag.id.toUpperCase();
    if (id === "COMM" || id === "USLT" || id === "APIC"
      || id === "UNSYNCEDLYRICS" || id === "LYRICS" || /^LYRICS[-_][A-Z]{3}$/u.test(id)) continue;
    if ([
      "INAM", "IART", "IPRD", "ICRD", "IGNR", "ICMT", "ITRK", "ISFT",
      "TIT1", "TIT2", "TIT3", "TPE1", "TPE2", "TPE3", "TPE4", "TALB", "TRCK", "TPOS",
      "TYER", "TDRC", "TDOR", "TCON", "TCOM", "TEXT", "TCOP", "TPUB", "TBPM", "TCMP",
      "TSRC", "TSSE", "TLAN",
    ].includes(id)) continue;
    if (!outputNative.some((candidate) => candidate.id.toUpperCase() === id && stable(candidate.value) === stable(tag.value))) {
      throw new WavFlacConversionError("metadata_loss", `The ${tag.id} metadata field could not be preserved.`);
    }
  }
  const sampleCount = (metadata: typeof sourceMetadata) => metadata.format.numberOfSamples
    ?? (metadata.format.duration !== undefined && metadata.format.sampleRate !== undefined
      ? Math.round(metadata.format.duration * metadata.format.sampleRate)
      : undefined);
  if (stable(sourceMetadata.format.sampleRate) !== stable(outputMetadata.format.sampleRate)
    || stable(sourceMetadata.format.numberOfChannels) !== stable(outputMetadata.format.numberOfChannels)
    || stable(sourceMetadata.format.bitsPerSample) !== stable(outputMetadata.format.bitsPerSample)
    || stable(sampleCount(sourceMetadata)) !== stable(sampleCount(outputMetadata))) {
    throw new WavFlacConversionError("conversion_failed", "The FLAC stream properties differ from the source WAV.");
  }
}
