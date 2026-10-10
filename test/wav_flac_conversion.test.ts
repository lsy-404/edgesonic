// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: pnpm exec tsx test/wav_flac_conversion.test.ts

import { assertMetadataPreserved, copyForTransfer, inspectIntegerPcmWav, WavFlacConversionError } from "../web/src/lib/wavFlacConvertCore";
import { readFile } from "node:fs/promises";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function wave(format: number, bits = 16) {
  const channels = 2;
  const rate = 44100;
  const data = new Uint8Array(channels * Math.ceil(bits / 8) * 2);
  const result = new Uint8Array(44 + data.length);
  const view = new DataView(result.buffer);
  const put = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) result[offset + index] = value.charCodeAt(index);
  };
  put(0, "RIFF"); view.setUint32(4, result.length - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, format, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true); view.setUint32(28, rate * channels * bits / 8, true);
  view.setUint16(32, channels * bits / 8, true); view.setUint16(34, bits, true);
  put(36, "data"); view.setUint32(40, data.length, true);
  return result;
}

function extensibleWave(validBits: number) {
  const result = new Uint8Array(72);
  const view = new DataView(result.buffer);
  const put = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) result[offset + index] = value.charCodeAt(index);
  };
  put(0, "RIFF"); view.setUint32(4, result.length - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, 40, true); view.setUint16(20, 0xfffe, true);
  view.setUint16(22, 1, true); view.setUint32(24, 48000, true); view.setUint32(28, 192000, true);
  view.setUint16(32, 4, true); view.setUint16(34, 32, true); view.setUint16(36, 22, true);
  view.setUint16(38, validBits, true); view.setUint32(40, 4, true);
  result.set([1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 44);
  put(60, "data"); view.setUint32(64, 4, true);
  return result;
}

function throwsCode(action: () => unknown, code: string) {
  try { action(); } catch (error) { return error instanceof WavFlacConversionError && error.code === code; }
  return false;
}

const pcm = inspectIntegerPcmWav(wave(1, 24));
assert(pcm.sampleRate === 44100 && pcm.channels === 2 && pcm.bitsPerSample === 24 && pcm.dataBytes === 12, "reads integer PCM stream properties");
const extensible = inspectIntegerPcmWav(extensibleWave(24));
assert(extensible.sampleRate === 48000 && extensible.channels === 1 && extensible.bitsPerSample === 24, "reads the valid bit depth in extensible PCM WAV");
assert(throwsCode(() => inspectIntegerPcmWav(wave(3)), "unsupported_wav"), "rejects floating-point WAV before conversion");
assert(throwsCode(() => inspectIntegerPcmWav(wave(6)), "unsupported_wav"), "rejects compressed WAV codecs");
const unsupportedChunk = new Uint8Array(wave(1).length + 10);
unsupportedChunk.set(wave(1));
unsupportedChunk.set([88, 88, 88, 88, 2, 0, 0, 0, 1, 2], wave(1).length);
new DataView(unsupportedChunk.buffer).setUint32(4, unsupportedChunk.length - 8, true);
assert(throwsCode(() => inspectIntegerPcmWav(unsupportedChunk), "metadata_loss"), "rejects metadata chunks that cannot be preserved");
assert(throwsCode(() => inspectIntegerPcmWav(wave(1).subarray(0, 40)), "invalid_wav"), "rejects truncated WAV input");
assert(throwsCode(() => inspectIntegerPcmWav(new Uint8Array([...wave(1), 1])), "invalid_wav"), "rejects unaccounted trailing bytes");

void (async () => {
  try {
    const source = new Uint8Array(await readFile("test/fixtures/wav-flac-metadata-source.wav"));
    const output = new Uint8Array(await readFile("test/fixtures/wav-flac-metadata-output.flac"));
    const transferCopy = copyForTransfer(source);
    structuredClone(transferCopy.buffer, { transfer: [transferCopy.buffer] });
    assert(source.byteLength > 0, "FFmpeg transfer copy leaves the metadata verification source attached");
    await assertMetadataPreserved(source, output);
    assert(true, "preserves RIFF INFO comments when FFmpeg maps ICMT to FLAC DESCRIPTION");
  } catch (error) {
    failures++;
    console.error("  ✗ tagged WAV/FLAC verification regression", error);
  }
  if (failures) process.exitCode = 1;
})();
