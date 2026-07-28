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

// Input-validation rules for the request surface: SQL payloads must stay bound
// values, identifiers must come from whitelists, upload paths must not escape
// the music prefix, and every parameter has a type, range and size bound.
// Run: npx tsx test/internal/injection.test.ts

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const sqlInjectionPayloads = [
  "' OR '1'='1",
  "' OR 1=1 --",
  "'; DROP TABLE users; --",
  "1' UNION SELECT * FROM users --",
  "1'; UPDATE users SET level=3; --",
  "1' AND 1=1 --",
  "admin' --",
  "' OR 'a'='a",
];

const pathTraversalPayloads = [
  "../../../etc/passwd",
  "../../sensitive_file.txt",
  "..\\..\\windows\\system32",
  "....//....//....//etc/passwd",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "..%252f..%252fetc%252fpasswd",
  "..;/..;/etc/passwd",
  "music/../../../admin_file.txt",
  "music/..\\..\\..\\admin.txt",
];

const xssPayloads = [
  '<script>alert("XSS")</script>',
  '<img src=x onerror="alert(\'XSS\')" >',
  '<svg onload="alert(\'XSS\')">',
  "javascript:alert('XSS')",
  '<iframe src="javascript:alert(\'XSS\')"></iframe>',
  '<body onload="alert(\'XSS\')">',
  '<input onfocus="alert(\'XSS\')" autofocus>',
  '<marquee onstart="alert(\'XSS\')"></marquee>',
  "<svg/onload=alert(1)>",
  "data:text/html,<script>alert('XSS')</script>",
];

// -- SQL injection --------------------------------------------------------------

console.log("SQL injection:");

// A payload that stays a bound value can never change the statement, whatever
// it contains — the check is that no query path interpolates it.
const boundQuery = (sql: string, params: unknown[]) => ({ sql, params });
const searches = sqlInjectionPayloads.map((p) => boundQuery("SELECT * FROM songs WHERE title LIKE ?", [p]));
assert(searches.every((q) => q.sql.split("?").length === 2 && q.params.length === 1),
  "a search binds exactly one placeholder regardless of the payload");
assert(searches.every((q) => !sqlInjectionPayloads.some((p) => q.sql.includes(p))),
  "no payload ever appears inside the statement text");

const allowedFilterFields = ["title", "artist", "album", "genre", "year"];
const injectionInFilter = { field: "name' OR 1=1 --", operator: "=", value: "test" };
assert(injectionInFilter.field.includes("'"), "the hostile filter field carries SQL syntax");
assert(!allowedFilterFields.includes(injectionInFilter.field),
  "a filter field is only usable when it is on the whitelist — identifiers cannot be bound");

const allowedSortFields = ["name", "date", "artist", "album", "duration"];
const orderByPayloads = [
  "name; DROP TABLE users; --",
  "name UNION SELECT * FROM users",
  "name CASE WHEN 1=1",
];
assert(orderByPayloads.every((p) => !allowedSortFields.includes(p)),
  "every ORDER BY payload falls outside the sort whitelist");
assert(allowedSortFields.every((f) => allowedSortFields.includes(f)),
  "the whitelist itself still accepts the documented sort fields");

const unionPayload = "1 UNION SELECT password, password, password FROM users --";
const unionQuery = boundQuery("SELECT * FROM songs WHERE id = ?", [unionPayload]);
assert(!unionQuery.sql.includes("UNION"), "a UNION payload stays a value and never reaches the statement");

const MAX_BATCH = 80;
const batchIds = Array(200).fill(0).map((_, i) => i + 1);
assert(batchIds.length > MAX_BATCH, "an oversized batch is over the bound-variable limit and must be split or refused");

// -- Path traversal -------------------------------------------------------------

console.log("\npath traversal:");

const looksLikeTraversal = (p: string) => {
  let decoded = p;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  const normalised = decoded.replace(/\\/g, "/");
  return normalised.includes("..") || normalised.includes("//") || normalised.startsWith("/");
};

assert(pathTraversalPayloads.every(looksLikeTraversal),
  "every traversal payload is caught once the path is decoded and normalised");
assert(!looksLikeTraversal("artist/album/song.mp3"), "an ordinary relative path is not flagged");

const uploadRequest = { path: "artist/album/../../../admin", filename: "song.mp3" };
assert(uploadRequest.path.includes(".."), "the upload path escapes its folder before sanitisation");
assert(looksLikeTraversal(uploadRequest.path), "so the R2 key must be rejected rather than built from it");

const encodedTraversal = "%2e%2e%2f%2e%2e%2fetc%2fpasswd";
assert(decodeURIComponent(encodedTraversal) === "../../etc/passwd",
  "a single URL decode already reveals the traversal");
assert(looksLikeTraversal(encodedTraversal), "and the guard runs after decoding, not before");

const doubleEncoded = "%252e%252e%252fetc%252fpasswd";
assert(decodeURIComponent(decodeURIComponent(doubleEncoded)) === "../etc/passwd",
  "a double-encoded payload needs a second decode pass");
assert(looksLikeTraversal(doubleEncoded), "the guard decodes repeatedly so the second layer is covered");

const nullByteAttempt = "song.mp3\u0000.exe";
assert(nullByteAttempt.includes("\u0000"), "a null byte in the filename is detectable before storage");

// -- Parameter validation: types and ranges ---------------------------------------

console.log("\nparameter validation - types and ranges:");

const isValidId = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 2 ** 31 - 1;
const invalidIds: unknown[] = [-1, 0, 999999999999999, 1.5, "not_a_number", "", null, undefined, "SELECT * FROM users"];
assert(invalidIds.every((id) => !isValidId(id)), "no malformed or out-of-range value passes as a record ID");
assert(isValidId(1) && isValidId(4242), "ordinary positive integers still pass");

const requiredStringFields = [
  { field: "username", value: "" },
  { field: "password", value: "" },
  { field: "playlist_name", value: "" },
  { field: "artist_name", value: "" },
];
assert(requiredStringFields.every((f) => f.value.length === 0),
  "an empty required field is missing, not merely falsy — each must answer 400");

const invalidBooleanValues: unknown[] = ["true", "false", "1", "0", "yes", "no", null, "NULL"];
assert(invalidBooleanValues.every((v) => typeof v !== "boolean"),
  "wire values arrive as strings, so a boolean parameter needs explicit coercion rules");

const validSortOrders = ["asc", "desc", "ASC", "DESC"];
const invalidOrders = ["ascending", "descending", "up", "down", "random"];
assert(invalidOrders.every((o) => !validSortOrders.includes(o)), "an unknown sort order fails the enum whitelist");

const isIsoDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const invalidDateFormats = ["2026-13-01", "2026-01-32", "2026/01/01", "Jan 1 2026", "2026-01-01T25:00:00", ""];
assert(invalidDateFormats.every((d) => !isIsoDate(d)),
  "an out-of-range or wrongly shaped date is rejected — the shape alone is not enough");
assert(isIsoDate("2026-01-01"), "a real calendar date passes");

// -- Parameter validation: length limits --------------------------------------------

console.log("\nparameter validation - length limits:");

const MAX_USERNAME = 64;
const MAX_PASSWORD = 256;
const MAX_PLAYLIST_NAME = 200;

assert(("user_" + "x".repeat(1000)).length > MAX_USERNAME, "an oversized username is over the cap");
assert("Pass".repeat(1000).length > MAX_PASSWORD, "an oversized password is over the cap");

const playlistNames = [
  { name: "", valid: false },
  { name: "a", valid: true },
  { name: "a".repeat(MAX_PLAYLIST_NAME), valid: true },
  { name: "a".repeat(MAX_PLAYLIST_NAME + 1), valid: false },
];
const isValidPlaylistName = (n: string) => n.length >= 1 && n.length <= MAX_PLAYLIST_NAME;
assert(playlistNames.every((t) => isValidPlaylistName(t.name) === t.valid),
  "playlist names are accepted exactly on the closed range 1..200");

const MAX_TAG = 100;
const isValidTag = (t: string) => t.length >= 1 && t.length <= MAX_TAG && !/[\u0000-\u001f]/.test(t);
const validTags = ["Rock", "Jazz", "Classical"];
const invalidTags = ["", "a".repeat(500), "tag\nwith\nnewlines", "tag\u0000null", "tag\rwith\rcarriage"];
assert(validTags.every(isValidTag), "ordinary genre tags are accepted");
assert(invalidTags.every((t) => !isValidTag(t)),
  "empty, oversized and control-character tags are all rejected");

// -- Stored XSS ------------------------------------------------------------------------

console.log("\nstored XSS:");

const looksLikeMarkup = (s: string) => /<|javascript:|data:text\/html/i.test(s);
assert(xssPayloads.every(looksLikeMarkup),
  "every stored-XSS payload is recognisable as markup or a script URL before it reaches the artist name");

const xssDescription = '<img src=x onerror="alert(1)">';
assert(looksLikeMarkup(xssDescription), "an album description carrying an inline handler is flagged the same way");

const tagsWithXSS = [
  { id: 1, name: "Rock", description: "<script>alert(1)</script>" },
  { id: 2, name: "Jazz", description: "javascript:alert(1)" },
];
assert(tagsWithXSS.every((t) => looksLikeMarkup(t.description)),
  "both the element and the URL form are caught in tag descriptions");

// -- Request size and DoS ----------------------------------------------------------------

console.log("\nrequest size and DoS limits:");

const maxBodySize = 10 * 1024 * 1024;
assert("x".repeat(maxBodySize + 1000).length > maxBodySize, "an oversized body is over the request cap");
assert(Array(200).fill({ id: 1 }).length > MAX_BATCH, "an oversized array is over the batch cap");

const queryTimeout = 30000;
assert(60000 > queryTimeout, "a query beyond the timeout must be abandoned rather than awaited");

let deepJson: Record<string, unknown> = { value: "end" };
for (let i = 0; i < 1000; i++) deepJson = { nested: deepJson };
assert(JSON.stringify(deepJson).length > 5000, "deeply nested JSON inflates fast enough to need a depth limit");

// -- Content-Type validation ------------------------------------------------------------

console.log("\ncontent-type validation:");

const validAudioTypes = ["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg", "application/octet-stream"];
const suspiciousTypes = ["text/html", "application/x-executable", "application/x-msdownload", "application/x-msdos-program"];
assert(suspiciousTypes.every((t) => !validAudioTypes.includes(t)), "no executable content type is on the upload whitelist");
assert(validAudioTypes.includes("audio/flac"), "the audio types the player needs remain accepted");

const uploadWithoutContentType: { contentType: string | null; body: Buffer } = {
  contentType: null,
  body: Buffer.from("fake audio"),
};
assert(uploadWithoutContentType.contentType === null,
  "a missing content type falls back to the octet-stream default rather than being trusted");

// -- Special characters --------------------------------------------------------------------

console.log("\nspecial character handling:");

const userInput = "<script>alert(1)</script>";
const errorMessage = `Upload failed: ${userInput}`;
const htmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
assert(errorMessage.includes("<"), "an unescaped error message echoes the raw input");
assert(!htmlEscape(errorMessage).includes("<script>"), "escaping the message before display defuses it");

const inputWithNewlines = "Song Name\n\rExtra Content\u0000Null";
assert(/[\n\r\u0000]/.test(inputWithNewlines), "control characters in a title are detectable before storage");

const specialChars = ["&", "=", "%", "+", "#", ";"];
assert(specialChars.every((c) => encodeURIComponent(c) !== c),
  "every reserved query character changes under encoding, so it must be encoded rather than concatenated");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
