// SPDX-License-Identifier: AGPL-3.0-or-later

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { assertMetadataPreserved, inspectIntegerPcmWav, WavFlacConversionError } from "./wavFlacConvertCore";

interface ConvertRequest { buffer: ArrayBuffer }

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ConvertRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

const coreBaseUrl = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
let visibleProgress = 0;

function reportProgress(percent: number) {
  visibleProgress = Math.max(visibleProgress, percent);
  workerScope.postMessage({ type: "progress", percent: visibleProgress });
}

async function loadAsset(url: string, mimeType: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the audio engine (${response.status}).`);
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: mimeType }));
}

async function hashDecodedPcm(ffmpeg: FFmpeg, input: string, output: string) {
  const exitCode = await ffmpeg.exec([
    "-hide_banner", "-nostdin", "-v", "error", "-i", input, "-map", "0:a:0", "-c:a", "pcm_s32le",
    "-f", "hash", "-hash", "sha256", output,
  ]);
  if (exitCode !== 0) throw new WavFlacConversionError("conversion_failed", "Could not verify the decoded PCM stream.");
  const result = await ffmpeg.readFile(output, "utf8");
  return typeof result === "string" ? result.trim() : new TextDecoder().decode(result).trim();
}

workerScope.onmessage = async (event: MessageEvent<ConvertRequest>) => {
  const source = new Uint8Array(event.data.buffer);
  let coreUrl: string | undefined;
  let wasmUrl: string | undefined;
  const ffmpeg = new FFmpeg();
  try {
    const pcm = inspectIntegerPcmWav(source);
    reportProgress(5);
    coreUrl = await loadAsset(`${coreBaseUrl}/ffmpeg-core.js`, "text/javascript");
    wasmUrl = await loadAsset(`${coreBaseUrl}/ffmpeg-core.wasm`, "application/wasm");
    await ffmpeg.load({ coreURL: coreUrl, wasmURL: wasmUrl });
    ffmpeg.on("progress", ({ progress }) => {
      if (Number.isFinite(progress)) reportProgress(Math.min(68, 20 + Math.round(progress * 48)));
    });
    reportProgress(20);
    await ffmpeg.writeFile("input.wav", source);
    const encodeExit = await ffmpeg.exec([
      "-hide_banner", "-nostdin", "-v", "error", "-i", "input.wav", "-map", "0:a:0", "-map", "0:v?",
      "-map_metadata", "0", "-c:a", "flac", "-bits_per_raw_sample", String(pcm.bitsPerSample),
      "-compression_level", "8", "-c:v", "copy", "output.flac",
    ]);
    if (encodeExit !== 0) throw new WavFlacConversionError("conversion_failed", "FFmpeg could not encode this WAV as FLAC.");
    reportProgress(70);
    const flac = await ffmpeg.readFile("output.flac");
    if (typeof flac === "string") throw new WavFlacConversionError("conversion_failed", "FFmpeg returned invalid FLAC data.");
    const sourceHash = await hashDecodedPcm(ffmpeg, "input.wav", "source.sha256");
    reportProgress(82);
    const outputHash = await hashDecodedPcm(ffmpeg, "output.flac", "output.sha256");
    if (!sourceHash || sourceHash !== outputHash) {
      throw new WavFlacConversionError("conversion_failed", "Decoded audio samples changed; the FLAC was discarded.");
    }
    await assertMetadataPreserved(source, flac);
    reportProgress(98);
    const buffer = Uint8Array.from(flac).buffer;
    workerScope.postMessage({ type: "done", buffer }, [buffer]);
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      code: error instanceof WavFlacConversionError ? error.code : "conversion_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ffmpeg.terminate();
    if (coreUrl) URL.revokeObjectURL(coreUrl);
    if (wasmUrl) URL.revokeObjectURL(wasmUrl);
  }
};
