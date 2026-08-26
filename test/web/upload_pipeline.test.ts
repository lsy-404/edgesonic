// SPDX-License-Identifier: AGPL-3.0-or-later

import { runUploadPipeline } from "../../web/src/lib/uploadPipeline";
import { audioKindAtIndex, classifyUploadItems, normalizeAudioOrder } from "../../web/src/lib/uploadQueue";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

async function main() {
  const events: string[] = [];
  let releaseFirstUpload!: () => void;
  const firstUpload = new Promise<void>((resolve) => { releaseFirstUpload = resolve; });

  const pipeline = runUploadPipeline({
    ready: ["plain"],
    encrypted: ["first", "second", "broken"],
    uploadConcurrency: 1,
    conversionConcurrency: 1,
    maxConversionBytes: 1024,
    conversionBytes() { return 1; },
    async uploadReady(item) { events.push(`upload:${item}`); },
    async convert(item) {
      events.push(`convert:${item}`);
      if (item === "broken") throw new Error("missing key");
      return `${item}:ordinary`;
    },
    async uploadConverted(item, output) {
      events.push(`upload:${item}:${output}`);
      if (item === "first") await firstUpload;
    },
    onConversionFailure(item) { events.push(`failed:${item}`); },
  });

  await Promise.resolve();
  await Promise.resolve();
  assert(events.includes("upload:plain"), "ordinary files upload while conversion is in progress");
  assert(events.includes("convert:first"), "first encrypted file begins local conversion");
  assert(!events.includes("convert:second"), "conversion waits for the converted file upload before producing another output");
  releaseFirstUpload();
  await pipeline;
  assert(events.includes("upload:first:first:ordinary") && events.includes("upload:second:second:ordinary"), "only converted outputs reach the upload stage");
  assert(events.includes("failed:broken"), "conversion failure is reported without an upload attempt");
  assert(!events.some((event) => event === "upload:broken" || event.startsWith("upload:broken:")), "encrypted source is never uploaded");

  let activeUploads = 0;
  let peakUploads = 0;
  await runUploadPipeline({
    ready: ["plain"],
    encrypted: ["encrypted"],
    uploadConcurrency: 1,
    conversionConcurrency: 1,
    maxConversionBytes: 1024,
    conversionBytes() { return 1; },
    async uploadReady() {
      activeUploads++; peakUploads = Math.max(peakUploads, activeUploads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeUploads--;
    },
    async convert() { return "ordinary"; },
    async uploadConverted() {
      activeUploads++; peakUploads = Math.max(peakUploads, activeUploads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeUploads--;
    },
    onConversionFailure() { throw new Error("unexpected conversion failure"); },
  });
  assert(peakUploads === 1, "ready and converted uploads share one concurrency limit");

  const memoryEvents: string[] = [];
  let releaseMemoryUpload!: () => void;
  const memoryUpload = new Promise<void>((resolve) => { releaseMemoryUpload = resolve; });
  const memoryPipeline = runUploadPipeline({
    ready: [] as Array<{ name: string; size: number }> ,
    encrypted: [{ name: "first", size: 64 }, { name: "second", size: 64 }, { name: "oversized", size: 101 }],
    uploadConcurrency: 1,
    conversionConcurrency: 2,
    maxConversionBytes: 100,
    conversionBytes(item) { return item.size; },
    async uploadReady() { /* no ready inputs */ },
    async convert(item) { memoryEvents.push(`convert:${item.name}`); return item.name; },
    async uploadConverted(item) {
      memoryEvents.push(`upload:${item.name}`);
      if (item.name === "first") await memoryUpload;
    },
    onConversionFailure(item, error) { memoryEvents.push(`failed:${item.name}:${error instanceof Error ? error.name : "unknown"}`); },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert(memoryEvents.includes("convert:first") && !memoryEvents.includes("convert:second"), "byte gate blocks another conversion while its output is retained");
  releaseMemoryUpload();
  await memoryPipeline;
  assert(memoryEvents.includes("convert:second"), "byte reservation releases after converted upload settles");
  assert(memoryEvents.includes("failed:oversized:ConversionMemoryLimitError"), "a file above the byte limit fails before conversion");

  const queue = classifyUploadItems([
    { name: "song.ncm" },
    { name: "song.mp3" },
    { name: "song.qmcflac" },
  ]);
  normalizeAudioOrder(queue);
  assert(audioKindAtIndex(queue, 0) === "audio" && queue[1].kind === "variant" && audioKindAtIndex(queue, 2) === "variant", "encrypted and ordinary files share queue-order variant assignment");
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
