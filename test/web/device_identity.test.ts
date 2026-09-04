// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const root = join(__dirname, "..", "..");
const api = readFileSync(join(root, "web", "src", "api.ts"), "utf8");

console.log("First-party device identity:");
assert(api.includes('const DEVICE_ID_STORAGE_KEY = "edgesonic_device_id"'), "uses a dedicated local device ID");
assert(api.includes("crypto.randomUUID()"), "creates a random device ID when absent");
assert(api.includes("transientDeviceId ||="), "keeps authentication usable when persistent storage is unavailable");
assert(api.includes('next.set("X-EdgeSonic-Device", firstPartyDeviceId())'), "sends the device ID in the authentication request header");
assert(/auth\/login[\s\S]{0,300}headers:\s*deviceHeaders/.test(api), "login includes the first-party device header");
assert(/auth\/register[\s\S]{0,300}headers:\s*deviceHeaders/.test(api), "registration includes the first-party device header");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
