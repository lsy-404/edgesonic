// SPDX-License-Identifier: AGPL-3.0-or-later

import { runUploadPipeline } from "../../web/src/lib/uploadPipeline";

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
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
