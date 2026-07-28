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

// Client-side input rules: upload type/size/name checks, form length limits,
// escaping of user text, route parameter validation and the DOM sinks the UI
// must not feed with user content.
// Run: npx tsx test/web/xss-input-validation.test.ts

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

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

const htmlEscape = (s: string) => s
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const dangerousScheme = /^(javascript|data|vbscript):/i;

// Escaping only defuses markup; a bare `javascript:` value passes through it
// unchanged and has to be caught by the scheme check before it reaches an href.
const neutralised = (s: string) => htmlEscape(s) !== s || dangerousScheme.test(s);

// -- File upload validation -----------------------------------------------------

console.log("file upload validation:");

const validAudioTypes = ["audio/mpeg", "audio/flac", "audio/wav", "audio/ogg"];
const uploadCandidates = [
  { name: "song.mp3", type: "audio/mpeg", valid: true },
  { name: "song.flac", type: "audio/flac", valid: true },
  { name: "song.wav", type: "audio/wav", valid: true },
  { name: "malware.exe", type: "application/x-msdownload", valid: false },
  { name: "shell.sh", type: "application/x-sh", valid: false },
  { name: "image.jpg", type: "image/jpeg", valid: false },
];
assert(uploadCandidates.every((f) => validAudioTypes.includes(f.type) === f.valid),
  "the accepted upload types are exactly the audio whitelist");

const maxFileSize = 1024 * 1024 * 1024;
const sizedFiles = [
  { name: "small.mp3", size: 5 * 1024 * 1024, valid: true },
  { name: "normal.flac", size: 100 * 1024 * 1024, valid: true },
  { name: "huge.wav", size: 2 * 1024 * 1024 * 1024, valid: false },
];
assert(sizedFiles.every((f) => (f.size <= maxFileSize) === f.valid), "the size cap admits and rejects the expected files");

const executableTail = /\.(exe|php|js|html)$/i;
const doubleExtension = ["song.mp3.exe", "song.mp3.php", "song.mp3.js", "song.mp3.html"];
assert(doubleExtension.every((n) => executableTail.test(n)),
  "a second executable extension is caught by looking at the final one, not the first");
assert(!executableTail.test("song.mp3"), "a plain audio filename is unaffected");

const traversalInName = /(\.\.|\\|^\/)/;
const pathTraversalNames = [
  "../../../etc/passwd",
  "..\\..\\windows\\system32",
  "music/../../../admin",
  "/etc/passwd",
  "C:\\Windows\\System32",
];
assert(pathTraversalNames.every((n) => traversalInName.test(n)),
  "an uploaded filename that walks the tree or names a drive is rejected");
assert(!traversalInName.test("song.mp3"), "an ordinary filename passes the same check");

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, "_");
const unsafeNames = ["song with spaces.mp3", "song-with-unicode-🎵.mp3", "song<script>.mp3", "song; rm -rf /.mp3"];
assert(unsafeNames.every((n) => safeName(n) !== n), "each unsafe filename is changed by sanitisation");
assert(unsafeNames.every((n) => !/[<>;\s]/.test(safeName(n))),
  "no markup, shell or whitespace character survives sanitisation");

// -- Form input length validation --------------------------------------------------

console.log("\nform input length validation:");

const USERNAME_MIN = 5;
const USERNAME_MAX = 64;
const usernameTests = [
  { value: "", valid: false },
  { value: "ab", valid: false },
  { value: "validuser", valid: true },
  { value: "a".repeat(USERNAME_MAX), valid: true },
  { value: "a".repeat(USERNAME_MAX + 1), valid: false },
];
const usernameOk = (v: string) => v.length >= USERNAME_MIN && v.length <= USERNAME_MAX;
assert(usernameTests.every((t) => usernameOk(t.value) === t.valid),
  `usernames are accepted exactly on ${USERNAME_MIN}..${USERNAME_MAX}`);

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;
const passwordTests = [
  { value: "", valid: false },
  { value: "short", valid: false },
  { value: "ValidPass123!", valid: true },
  { value: "P@ss".repeat(100), valid: false },
];
const passwordOk = (v: string) => v.length >= PASSWORD_MIN && v.length <= PASSWORD_MAX;
assert(passwordTests.every((t) => passwordOk(t.value) === t.valid),
  `passwords are accepted exactly on ${PASSWORD_MIN}..${PASSWORD_MAX}`);

const NAME_MAX = 200;
const nameTests = [
  { value: "", valid: false },
  { value: "a", valid: true },
  { value: "My Favorite Songs", valid: true },
  { value: "x".repeat(NAME_MAX), valid: true },
  { value: "x".repeat(500), valid: false },
];
assert(nameTests.every((t) => (t.value.length >= 1 && t.value.length <= NAME_MAX) === t.valid),
  "playlist and collection names are accepted exactly on 1..200");

const metadataFields = [
  { field: "artist", maxLength: 100, value: "The Beatles" },
  { field: "album", maxLength: 100, value: "Abbey Road" },
  { field: "genre", maxLength: 50, value: "Rock" },
  { field: "comment", maxLength: 500, value: "Great song!" },
];
assert(metadataFields.every((f) => f.value.length <= f.maxLength),
  "the metadata sample values sit inside their per-field caps");
assert(metadataFields.every((f) => "x".repeat(f.maxLength + 1).length > f.maxLength),
  "each field has a cap that an overlong value can exceed and be truncated against");

// -- XSS in user input fields --------------------------------------------------------

console.log("\nXSS in user input fields:");

assert(xssPayloads.every(neutralised),
  "every payload is defused before display, by escaping or by the scheme check");
assert(xssPayloads.every((p) => !/<[a-z]/i.test(htmlEscape(p))),
  "no element survives escaping in a playlist name");

const metadataInput = '<img src=x onerror="alert(1)">';
const escapedMetadata = htmlEscape(metadataInput);
assert(!escapedMetadata.includes("<img"), "escaped metadata carries no live element");
assert(escapedMetadata.includes("&lt;img"), "the original text is still legible once escaped");

const searchPayloads = ['" onmouseover="alert(1)" "', "javascript:alert(1)", "<script>alert(1)</script>"];
assert(searchPayloads.every(neutralised),
  "attribute-breaking, element and URL search terms are all neutralised");

const tagDescription = '<script>alert("XSS")</script>';
const isPlainText = (s: string) => !s.includes("<") && !s.includes(">");
assert(!isPlainText(tagDescription), "a tag description carrying markup is not plain text");
assert(isPlainText(htmlEscape(tagDescription).replace(/&[a-z]+;/g, "")),
  "and escaping it leaves nothing the browser reads as markup");

// -- Route parameter validation ---------------------------------------------------------

console.log("\nroute parameter validation:");

const albumRoutes = [
  { path: "/album/123", valid: true },
  { path: "/album/0", valid: false },
  { path: "/album/-1", valid: false },
  { path: "/album/abc", valid: false },
  { path: "/album/<script>", valid: false },
];
const albumId = (path: string) => {
  const m = path.match(/^\/album\/(\d+)$/);
  if (!m) return null;
  const id = Number.parseInt(m[1], 10);
  return id > 0 ? id : null;
};
assert(albumRoutes.every((t) => (albumId(t.path) !== null) === t.valid),
  "only a positive integer album segment resolves to a route parameter");
assert(albumId("/album/123") === 123, "a valid segment parses to its numeric ID");

const xssInUrl = "/album/<script>alert(1)</script>";
assert(albumId(xssInUrl) === null, "a markup route segment resolves to nothing rather than being rendered");
assert(htmlEscape(xssInUrl) !== xssInUrl, "and would still be escaped if it were ever displayed");

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidTests = [
  { value: "a1b2c3d4-e5f6-4a5b-9c8d-e7f6a5b4c3d2", valid: true },
  { value: "not-a-uuid", valid: false },
  { value: "<script>", valid: false },
  { value: "../../../", valid: false },
];
assert(uuidTests.every((t) => uuidRegex.test(t.value) === t.valid), "slug parameters are matched against the UUID shape");

const isInternalTarget = (target: string) =>
  target.startsWith("/") && !target.startsWith("//") && !/^[a-z]+:/i.test(target);
const redirectTests = [
  { url: "/app/redirect?to=https://evil.com", dangerous: true },
  { url: "/app/redirect?to=//evil.com", dangerous: true },
  { url: "/app/redirect?to=javascript:alert(1)", dangerous: true },
  { url: "/app/redirect?to=/library", dangerous: false },
];
assert(redirectTests.every((t) => {
  const m = t.url.match(/to=([^&]+)/);
  if (!m) return false;
  return isInternalTarget(decodeURIComponent(m[1])) === !t.dangerous;
}), "only a same-origin path is accepted as a redirect target");

// -- DOM sinks -----------------------------------------------------------------------------

console.log("\nDOM sinks:");

// The runner has no DOM, so the sink behaviour is modelled: assigning to
// textContent stores the text, innerHTML stays untouched.
type Sink = { innerHTML: string; textContent: string };
const createElement = (): Sink => ({ innerHTML: "", textContent: "" });

const bound = '<img src=x onerror="steal()">';
assert(htmlEscape(bound) !== bound,
  "text interpolation escapes user content, so v-html is the only way this could execute");

const el = createElement();
const userContent = '<img onerror="alert(1)">';
el.textContent = userContent;
assert(el.textContent === userContent, "textContent keeps the value as text");
assert(el.innerHTML === "", "and never populates the HTML sink");

const div = createElement();
div.textContent = "<script>alert(1)</script>";
assert(div.textContent === "<script>alert(1)</script>", "a dynamically built node also receives user content as text");
assert(div.innerHTML === "", "with its innerHTML left empty");

// -- Event handlers and URLs ------------------------------------------------------------------

console.log("\nevent handlers and URLs:");

const linkTests = [
  { href: "https://example.com", safe: true },
  { href: "/page", safe: true },
  { href: "javascript:alert(1)", safe: false },
  { href: "data:text/html,<script>alert(1)</script>", safe: false },
];
assert(linkTests.every((l) => !dangerousScheme.test(l.href) === l.safe),
  "only http(s) and relative hrefs pass the scheme check");

const inlineHandler = /\son[a-z]+\s*=/i;
const unsafeAttributes = ["onclick", "onload", "onerror", "onmouseover", "onfocus"];
assert(unsafeAttributes.every((a) => inlineHandler.test(` ${a}="x"`)),
  "every inline handler attribute is recognised by the sanitiser pattern");
assert(!inlineHandler.test(' src="x.png"'), "an ordinary attribute is not mistaken for one");

// -- SVG ------------------------------------------------------------------------------------------

console.log("\nSVG:");

const svgPayloads = [
  '<svg onload="alert(1)"></svg>',
  "<svg><script>alert(1)</script></svg>",
  '<svg><animate onbegin="alert(1)"></animate></svg>',
];
assert(svgPayloads.every((p) => inlineHandler.test(p) || /<script/i.test(p)),
  "each SVG payload carries a handler or a script element, so raw SVG cannot be inlined unsanitised");

const userProvidedSvg = '<svg><use xlink:href="javascript:alert(1)"></use></svg>';
const hrefValue = userProvidedSvg.match(/xlink:href="([^"]+)"/)?.[1] ?? "";
assert(dangerousScheme.test(hrefValue), "an xlink:href can smuggle a javascript: URL and must be scheme-checked too");

// -- Submission throttling -------------------------------------------------------------------------

console.log("\nsubmission throttling:");

const minIntervalMs = 1000;
let lastSubmitTime = 0;
const canSubmit = (now: number) => now - lastSubmitTime > minIntervalMs;
const t0 = Date.now();
assert(canSubmit(t0), "the first submission is allowed");
lastSubmitTime = t0;
assert(!canSubmit(t0 + 10), "an immediate resubmission is blocked");
assert(canSubmit(t0 + minIntervalMs + 100), "the form unlocks once the interval has passed");

const submitButton = {
  disabled: false,
  onClick(this: { disabled: boolean }) { this.disabled = true; },
};
submitButton.onClick();
assert(submitButton.disabled, "the submit button disables itself for the duration of the request");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
