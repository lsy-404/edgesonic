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

//
// Upstream credentials typed into the clone form must never outlive the tab,
// never be written to persistent storage, and never travel in a URL.
//
// These are source-level checks: the clone flow is a long-running routine
// inside a single view, and the properties worth guarding are structural
// (which storage it writes, which transport carries the password) rather
// than behavioural. Booting the SFC would not observe them any better.
//
// Run: npx tsx test/web/clone-credentials-security.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const root = join(__dirname, "..", "..");
const tools = readFileSync(join(root, "web", "src", "views", "Tools.vue"), "utf8");
const clone = readFileSync(join(root, "worker", "src", "endpoints", "edgesonic", "clone.ts"), "utf8");

console.log("Clone credentials never reach persistent storage:");
{
  // localStorage survives the browser closing, so nothing in the clone view
  // may touch it — any XSS then reads the upstream password at leisure.
  assert(!/\blocalStorage\b/.test(tools), "the clone view never touches localStorage");

  // What the resume cache does persist is session-scoped and holds only the
  // ids already copied.
  const saved = tools.match(/sessionStorage\.setItem\([\s\S]*?\);/)?.[0] ?? "";
  assert(saved.length > 0, "resume progress is cached in sessionStorage");
  assert(
    saved.includes("metadataDone") && saved.includes("audioDone"),
    "the cached payload is the copied-id lists",
  );
  assert(
    !/password|username|token|credential/i.test(saved),
    "no credential field is written into the cache",
  );
}

console.log("\nThe upstream password never lands in a URL:");
{
  // Subsonic salted-token auth: the URL carries md5(password + salt) and the
  // salt, so an access log or Referer never sees the password itself.
  assert(
    /t:\s*md5\(password \+ s\)/.test(tools),
    "upstream calls are signed with a salted token",
  );
  assert(!/\bp:\s*password\b/.test(tools), "no plaintext p= parameter is built");
  // https://user:pass@host — deprecated, and captured by history and logs.
  assert(
    !/:\$\{[^}]*password[^}]*\}@/i.test(tools),
    "no user:pass@host URL is assembled",
  );
  // The clone form's own password is only ever read into the signing helpers
  // or a request body, never concatenated into a query string.
  const queryConcat = /[?&][a-z]+=\$\{[^}]*password[^}]*\}/i.test(tools);
  assert(!queryConcat, "no query parameter interpolates the password");
}

console.log("\nCredentials reach our own worker in a POST body:");
{
  const proxyAt = tools.indexOf('"/edgesonic/clone/proxy"');
  assert(proxyAt >= 0, "the CORS proxy path is used");
  const proxyInit = tools.slice(proxyAt, proxyAt + 400);
  assert(proxyInit.includes('method: "POST"'), "the proxy is called with POST");
  assert(
    proxyInit.includes("JSON.stringify") && /username,\s*password/.test(proxyInit),
    "credentials ride in the JSON body",
  );

  // Worker side: read from the body, never from the query string.
  const handlerAt = clone.indexOf('cloneRoutes.post("/clone/proxy"');
  assert(handlerAt >= 0, "the worker exposes the proxy route");
  const handler = clone.slice(handlerAt);
  const body = handler.slice(0, handler.indexOf("});"));
  assert(body.includes("c.req.json<"), "the handler parses credentials from the body");
  assert(!/c\.req\.query\(\s*["'](?:password|u|p|username)["']\s*\)/.test(body), "the handler reads no credential query param");
  assert(
    body.includes("!body.username || !body.password"),
    "the handler rejects a request with either credential missing",
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
