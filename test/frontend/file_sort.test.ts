// SPDX-License-Identifier: AGPL-3.0-or-later

// Run: npx tsx test/frontend/file_sort.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareDirectoryEntries, compareFileEntries } from "../../web/src/lib/fileSort";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const files = [
  { name: "older.flac", size: 30, modifiedAt: 100 },
  { name: "newer.mp3", size: 20, modifiedAt: 300 },
  { name: "middle.mp3", size: 10, modifiedAt: 200 },
  { name: "unknown.wav", size: 40, modifiedAt: null },
];

console.log("file modified-time sorting:");
{
  const ascending = [...files].sort((a, b) => compareFileEntries(a, b, "modified", "asc"));
  assert(ascending.map((f) => f.name).join(",") === "older.flac,middle.mp3,newer.mp3,unknown.wav", "ascending is oldest to newest with unknown last");

  const descending = [...files].sort((a, b) => compareFileEntries(a, b, "modified", "desc"));
  assert(descending.map((f) => f.name).join(",") === "newer.mp3,middle.mp3,older.flac,unknown.wav", "descending is newest to oldest with unknown last");
}

console.log("directory modified-time sorting:");
{
  const dirs = [
    { name: "old", modifiedAt: 100 },
    { name: "new", modifiedAt: 200 },
    { name: "unknown", modifiedAt: null },
  ];
  dirs.sort((a, b) => compareDirectoryEntries(a, b, "modified", "desc"));
  assert(dirs.map((d) => d.name).join(",") === "new,old,unknown", "known directory times sort before unknown times");
}

console.log("file manager wiring:");
{
  const root = join(__dirname, "..", "..");
  const source = readFileSync(join(root, "web", "src", "views", "Files.vue"), "utf8");
  assert(/<option value="modified">/.test(source), "modified time is available in the sort selector");
  assert(/formatModifiedTime\(f\.modifiedAt\)/.test(source), "file rows show the value used for sorting");
}

if (failures) process.exit(1);
