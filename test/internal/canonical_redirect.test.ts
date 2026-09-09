// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run: npx tsx test/internal/canonical_redirect.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "..", "worker/src/index.ts"), "utf8");
const hasRedirect = /legacyHost && canonicalHost && url\.hostname === legacyHost/.test(source)
  && /url\.hostname = canonicalHost/.test(source)
  && /c\.redirect\(url\.toString\(\), 308\)/.test(source);

if (!hasRedirect) {
  console.error("canonical redirect middleware is missing or is not permanent");
  process.exit(1);
}

console.log("canonical redirect middleware preserves the request URL with a 308 response");
