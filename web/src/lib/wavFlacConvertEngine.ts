// SPDX-License-Identifier: AGPL-3.0-or-later

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { assertMetadataPreserved, copyForTransfer, inspectIntegerPcmWav } from "./wavFlacConvertCore";
import { WavFlacConversionError } from "./wavFlacConvertCore";

const coreBaseUrl = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

export interface LosslessConversionEvidence {
  sourceSha256: string;
  outputSha256: string;
  sourcePcmSha256: string;
  outputPcmSha256: string;
  sourceBytes: number;
  outputBytes: number;
  format: { sampleRate: number; channels: number; bitsPerSample: number };
  metadataPreserved: true;
}

export interface LosslessConversion {
  flac: Uint8Array<ArrayBuffer>;
  evidence: LosslessConversionEvidence;
}

async function loadAsset(url: string, mimeType: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the audio engine (${response.status}).`);
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: mimeType }));
}

export async function loadFfmpeg(ffmpeg: FFmpeg, signal?: AbortSignal) {
  let coreUrl: string | undefined;
  let wasmUrl: string | undefined;
  try {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    coreUrl = await loadAsset(`${coreBaseUrl}/ffmpeg-core.js`, "text/javascript");
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    wasmUrl = await loadAsset(`${coreBaseUrl}/ffmpeg-core.wasm`, "application/wasm");
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    await ffmpeg.load({ coreURL: coreUrl, wasmURL: wasmUrl });
  } catch (error) {
    if (coreUrl) URL.revokeObjectURL(coreUrl);
    if (wasmUrl) URL.revokeObjectURL(wasmUrl);
    throw error;
  }
  return () => {
    if (coreUrl) URL.revokeObjectURL(coreUrl);
    if (wasmUrl) URL.revokeObjectURL(wasmUrl);
  };
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashDecodedPcm(ffmpeg: FFmpeg, input: string, output: string) {
  const exitCode = await ffmpeg.exec([
    "-hide_banner", "-nostdin", "-v", "error", "-i", input, "-map", "0:a:0", "-c:a", "pcm_s32le",
    "-f", "hash", "-hash", "sha256", output,
  ]);
  if (exitCode !== 0) throw new WavFlacConversionError("conversion_failed", "Could not verify the decoded PCM stream.");
  const result = await ffmpeg.readFile(output, "utf8");
  const hash = typeof result === "string" ? result.trim() : new TextDecoder().decode(result).trim();
  return hash.replace(/^SHA256=/i, "").toLowerCase();
}

export async function convertIntegerPcmWav(source: Uint8Array, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<LosslessConversion> {
  const format = inspectIntegerPcmWav(source);
  const ffmpeg = new FFmpeg();
  let releaseAssets: (() => void) | undefined;
  const onAbort = () => ffmpeg.terminate();
  try {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    signal?.addEventListener("abort", onAbort, { once: true });
    onProgress?.(5);
    releaseAssets = await loadFfmpeg(ffmpeg, signal);
    ffmpeg.on("progress", ({ progress }) => {
      if (Number.isFinite(progress)) onProgress?.(Math.min(68, 20 + Math.round(progress * 48)));
    });
    await ffmpeg.writeFile("input.wav", copyForTransfer(source));
    const encodeExit = await ffmpeg.exec([
      "-hide_banner", "-nostdin", "-v", "error", "-i", "input.wav", "-map", "0:a:0", "-map", "0:v?",
      "-map_metadata", "0", "-c:a", "flac", "-bits_per_raw_sample", String(format.bitsPerSample),
      "-compression_level", "8", "-c:v", "copy", "output.flac",
    ]);
    if (encodeExit !== 0) throw new WavFlacConversionError("conversion_failed", "FFmpeg could not encode this WAV as FLAC.");
    onProgress?.(70);
    const encoded = await ffmpeg.readFile("output.flac");
    if (typeof encoded === "string") throw new WavFlacConversionError("conversion_failed", "FFmpeg returned invalid FLAC data.");
    const flac = new Uint8Array(encoded);
    const sourcePcmSha256 = await hashDecodedPcm(ffmpeg, "input.wav", "source.sha256");
    onProgress?.(82);
    const outputPcmSha256 = await hashDecodedPcm(ffmpeg, "output.flac", "output.sha256");
    if (!sourcePcmSha256 || sourcePcmSha256 !== outputPcmSha256) {
      throw new WavFlacConversionError("conversion_failed", "Decoded audio samples changed; the FLAC was discarded.");
    }
    await assertMetadataPreserved(source, flac);
    onProgress?.(98);
    return {
      flac,
      evidence: {
        sourceSha256: await sha256(source),
        outputSha256: await sha256(flac),
        sourcePcmSha256,
        outputPcmSha256,
        sourceBytes: source.byteLength,
        outputBytes: flac.byteLength,
        format: { sampleRate: format.sampleRate, channels: format.channels, bitsPerSample: format.bitsPerSample },
        metadataPreserved: true,
      },
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    ffmpeg.terminate();
    releaseAssets?.();
  }
}
