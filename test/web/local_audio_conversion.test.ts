// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/web/local_audio_conversion.test.ts

import { decryptQMC1, ready as cryptoReady } from "@clamber_l/crypto/inline";
import {
  convertEncryptedBytes,
  LocalAudioConversionError,
} from "../../web/src/lib/localAudioConvertCore";
import { convertedFileName } from "../../web/src/lib/localAudioConvertTypes";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function run() {
  console.log("browser-local encrypted audio conversion:");
  await cryptoReady;

  const flac = new Uint8Array(8192);
  flac.set([0x66, 0x4c, 0x61, 0x43]);
  for (let index = 4; index < flac.length; index++) flac[index] = index % 251;

  const qmc1 = flac.slice();
  decryptQMC1(qmc1, 0);
  const progress: number[] = [];
  const qmcResult = await convertEncryptedBytes("qmc0", qmc1, (percent) => progress.push(percent));
  assert(qmcResult.extension === "flac" && qmcResult.mimeType === "audio/flac", "QMCv1 output is sniffed from decrypted bytes");
  assert(equalBytes(qmcResult.data, flac), "QMCv1 conversion restores the original audio bytes");
  assert(progress.length > 1 && progress[progress.length - 1] >= 95, "conversion reports local progress");

  const uc = flac.map((value) => value ^ 0xa3);
  const ucResult = await convertEncryptedBytes("uc", uc);
  assert(ucResult.extension === "flac" && equalBytes(ucResult.data, flac), "NetEase UC cache converts locally without a server");

  const tm = new Uint8Array(128);
  const tmResult = await convertEncryptedBytes("tm2", tm);
  assert(tmResult.extension === "m4a", "TM input restores its MP4/M4A header");
  assert(Array.from(tmResult.data.subarray(4, 8)).join(",") === "102,116,121,112", "TM conversion writes the ftyp signature");

  assert(convertedFileName("album/song.ncm", "FLAC") === "album/song.flac", "converted output keeps the source stem and detected extension");

  let unsupported: unknown;
  try { await convertEncryptedBytes("unknown", flac); } catch (error) { unsupported = error; }
  assert(unsupported instanceof LocalAudioConversionError && unsupported.code === "unsupported_format", "unsupported encrypted formats fail before upload");

  let invalid: unknown;
  try { await convertEncryptedBytes("ncm", flac); } catch (error) { invalid = error; }
  assert(invalid instanceof LocalAudioConversionError && invalid.code === "invalid_file", "invalid NCM bytes are rejected instead of uploaded");

  if (failures) process.exitCode = 1;
}

void run();
