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

function stable(value: unknown): string {
  if (value instanceof Uint8Array) return Array.from(value).join(",");
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(Object.keys(object).sort().map((key) => [key, JSON.parse(stable(object[key]))])));
  }
  return JSON.stringify(value ?? null);
}

const COMMON_TAGS = [
  "title", "artists", "artist", "album", "albumartist", "albumartists", "year", "date", "originaldate",
  "track", "disk", "genre", "composer", "lyricist", "writer", "lyrics", "copyright", "publisher",
  "bpm", "compilation", "grouping", "subtitle", "isrc", "barcode", "catalognumber", "movementIndex",
  "movementTotal", "work", "replaygain_track_gain", "replaygain_album_gain",
] as const;

function commentTexts(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return entries.map((entry) => {
    if (entry && typeof entry === "object" && "text" in entry) return String((entry as { text: unknown }).text);
    return String(entry);
  }).sort();
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
  const sourceComments = commentTexts(sourceTags.comment);
  const outputComments = commentTexts(outputTags.comment);
  const outputDescriptions = commentTexts(outputTags.description);
  for (const tag of Object.values(outputMetadata.native).flat()) {
    if (tag.id.toUpperCase() === "DESCRIPTION") outputDescriptions.push(...commentTexts(tag.value));
  }
  if (stable(sourceComments) !== stable([...outputComments, ...outputDescriptions].sort())) {
    throw new WavFlacConversionError("metadata_loss", "The comment metadata could not be preserved exactly.");
  }
  const sourcePictures = sourceMetadata.common.picture ?? [];
  const outputPictures = outputMetadata.common.picture ?? [];
  if (stable(sourcePictures) !== stable(outputPictures)) {
    throw new WavFlacConversionError("metadata_loss", "Embedded cover art could not be preserved exactly.");
  }
  if (stable(sourceMetadata.format.chapters) !== stable(outputMetadata.format.chapters)) {
    throw new WavFlacConversionError("metadata_loss", "Chapter metadata could not be preserved exactly.");
  }
  const sourceNative = Object.values(sourceMetadata.native).flat();
  const outputValues = [
    ...Object.values(outputMetadata.native).flat().map((tag) => stable(tag.value)),
    ...Object.values(outputTags).map(stable),
  ];
  const commonValues = new Set(Object.values(sourceTags).map(stable));
  for (const tag of sourceNative) {
    const serialized = stable(tag.value);
    if (!commonValues.has(serialized) && !outputValues.includes(serialized)) {
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
