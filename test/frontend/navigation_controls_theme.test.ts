// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run: npx tsx test/frontend/navigation_controls_theme.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const root = join(__dirname, "..", "..");
const app = readFileSync(join(root, "web/src/App.vue"), "utf8");
const palette = readFileSync(join(root, "web/src/assets/palette.css"), "utf8");

console.log("navigation controls:");
assert(/level >= 3 \? 'accent' : level >= 2 \? 'info' : 'muted'/.test(app), "super-admin badge uses the theme-aware accent variant");
assert(/\.nav-logout\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center/.test(app), "logout icon and label are centered together");
assert(/\.status-badge\.accent\s*\{[^}]*color:\s*var\(--color-accent-primary\)[^}]*border-color:\s*var\(--color-accent-primary\)[^}]*background:\s*var\(--color-accent-dim\)/.test(palette), "accent badge inherits the active theme tokens");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
