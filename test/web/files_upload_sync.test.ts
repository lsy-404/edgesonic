// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/web/files_upload_sync.test.ts

import { readFileSync } from "node:fs";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const source = readFileSync(new URL("../../web/src/views/Files.vue", import.meta.url), "utf8");

console.log("files upload synchronization:");
assert(source.includes("const UPLOAD_CONCURRENCY = 3"), "upload concurrency is bounded to three");
assert(source.includes("await mapConcurrent(queued.map"), "uploads use the shared concurrent queue");
assert(source.includes("item.kind === \"audio\" || item.kind === \"variant\""), "only audio items are sent to browser metadata parsing and pre-transcode profiles");
assert(source.includes("let kind: UploadKind = \"sidecar\""), "non-audio companions remain uploadable without being treated as audio");
assert(source.includes("webkitdirectory"), "sync upload accepts a directory selection");
assert(source.includes("OPENYYY_ENCRYPTED_EXTENSIONS"), "encrypted file extensions are recognized for local conversion guidance");
assert(source.includes("convertFirst"), "encrypted inputs are kept out of the upload batch with an explicit conversion state");
assert(source.includes("fileSortKey") && source.includes("folders-last"), "file sorting and folder placement controls are present");

if (failures) process.exitCode = 1;
