// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Run: npx tsx test/frontend/locale_messages_compile.test.ts
//
// vue-i18n compiles a message the first time it is rendered, so a string
// carrying its syntax by accident ("{{link}}", a bare "@" or "|") throws a
// SyntaxError that takes down whichever view happens to reference it. Compile
// every message up front instead of finding out in production.

import { readFileSync } from "node:fs";
import { baseCompile } from "@intlify/message-compiler";

let failures = 0;

function walk(node: unknown, path: string, out: [string, string][]): void {
  if (typeof node === "string") { out.push([path, node]); return; }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      walk(value, path ? `${path}.${key}` : key, out);
    }
  }
}

for (const locale of ["en", "zh-CN"]) {
  const url = new URL(`../../web/src/locales/${locale}.json`, import.meta.url);
  const messages: [string, string][] = [];
  walk(JSON.parse(readFileSync(url, "utf8")), "", messages);

  const broken: string[] = [];
  for (const [path, message] of messages) {
    try {
      baseCompile(message, { onError(e) { throw e; } });
    } catch (e) {
      broken.push(`${path}: ${(e as { code?: number }).code} — ${message}`);
    }
  }

  if (broken.length) {
    failures++;
    console.error(`  ✗ ${locale}.json: ${broken.length} message(s) fail to compile`);
    for (const line of broken) console.error(`      ${line}`);
  } else {
    console.log(`  ✓ ${locale}.json: all ${messages.length} messages compile`);
  }
}

if (failures) process.exit(1);
