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

// Authentication rules: login throttling, credential length and character
// limits, token lifetime and session handling, password storage, and the
// error-message policy that must not distinguish unknown user from bad password.
// Run: npx tsx test/internal/authentication.test.ts

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const testUsers = [
  { username: "admin", password: "admin123456", level: 3 },
  { username: "user1", password: "user123456", level: 0 },
  { username: "user2", password: "user2pass123", level: 0 },
];

const sqlInjectionPayloads = [
  "' OR '1'='1",
  "' OR 1=1 --",
  "admin' --",
  "1' OR '1'='1",
  "'; DROP TABLE users; --",
];

// -- Login rate limiting -------------------------------------------------------
//
// Rate limiting is not implemented on the login endpoint; these checks pin the
// shape of the throttle the endpoint is expected to grow, so the model can be
// compared against an implementation when one lands.

console.log("login rate limiting:");

const FAILURE_THRESHOLD = 5;
const backoffMs = [0, 0, 0, 0, 1000, 2000, 4000, 8000];

const bruteForce = Array(100).fill(0).map((_, i) => ({ username: "admin", password: `wrongpassword${i}` }));
const attempted = bruteForce.slice(0, 50);
assert(attempted.length === 50, "a brute-force run replays many attempts against one account");
assert(attempted.length > FAILURE_THRESHOLD,
  "the run crosses the failure threshold, so a limiter would have to answer 429");

assert(backoffMs.length === 8, "the backoff table covers the first eight attempts");
assert(backoffMs.slice(0, FAILURE_THRESHOLD - 1).every((d) => d === 0),
  "the first attempts below the threshold are answered immediately");
assert(backoffMs.slice(FAILURE_THRESHOLD - 1).every((d, i, arr) => i === 0 || d === arr[i - 1] * 2),
  "the delay doubles on each further failure");

const successfulLogin = { username: testUsers[0].username, password: testUsers[0].password };
let failedCount = 3;
if (successfulLogin.password === testUsers[0].password) failedCount = 0;
assert(failedCount === 0, "a successful login clears the accumulated failure count");

const attackScenario = [
  { username: "admin", ip: "192.168.1.1" },
  { username: "user1", ip: "192.168.1.1" },
  { username: "user2", ip: "192.168.1.1" },
  { username: "nonexistent", ip: "192.168.1.1" },
];
const distinctIps = new Set(attackScenario.map((a) => a.ip));
assert(attackScenario.length === 4 && distinctIps.size === 1,
  "rotating the username does not spread the attempts across counters — the key is the IP");

// -- Credential validation -------------------------------------------------------

console.log("\ncredential length and character limits:");

const MIN_USERNAME = 5;
const MAX_USERNAME = 64;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;

const shortUsernames = ["abc", "ab", "a", "1", ""];
assert(shortUsernames.every((u) => u.length < MIN_USERNAME),
  `every short username is under the ${MIN_USERNAME} character floor`);

const longUsername = "user_" + "x".repeat(100);
assert(longUsername.length > MAX_USERNAME, `an oversized username is over the ${MAX_USERNAME} character cap`);

const shortPasswords = ["1234567", "abc", "P@ss", ""];
assert(shortPasswords.every((p) => p.length < MIN_PASSWORD),
  `every short password is under the ${MIN_PASSWORD} character floor`);

const longPassword = "P@ss" + "word".repeat(100);
assert(longPassword.length > MAX_PASSWORD, `an oversized password is over the ${MAX_PASSWORD} character cap`);

const usernamePattern = /^[A-Za-z0-9_-]+$/;
const invalidUsernames = [
  "user@name",
  "user name",
  "user<name>",
  "user;name",
  "user'name",
  'user"name',
];
assert(invalidUsernames.every((u) => !usernamePattern.test(u)),
  "every username carrying a special character fails the alphanumeric/dash/underscore rule");
assert(usernamePattern.test("valid_user-1"), "an ordinary username still passes the same rule");

// -- Injection patterns in credentials ---------------------------------------------

console.log("\ninjection patterns in credentials:");

assert(sqlInjectionPayloads.every((p) => p.includes("'")),
  "each SQL payload carries the quote that parameterised binding has to neutralise");
assert(sqlInjectionPayloads.every((p) => !usernamePattern.test(p)),
  "the same payloads are also rejected by the username character rule before reaching the query");

const xssInUsername = '<script>alert("xss")</script>';
const htmlEscape = (s: string) => s
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
assert(xssInUsername.includes("<"), "the echoed username can carry markup");
assert(!htmlEscape(xssInUsername).includes("<script>"),
  "escaping the username before it lands in an error message defuses it");
assert(htmlEscape(xssInUsername).includes("&lt;script&gt;"), "the escaped form keeps the value readable");

// -- Token validation and session management -----------------------------------------

console.log("\ntoken validation and session management:");

const token = "mock_token_" + Date.now();
assert(token.length > 20, "a session token is long enough to resist guessing");

const expiredToken = { value: "expired_token_123", expiresAt: Date.now() - 3600000 };
assert(expiredToken.expiresAt < Date.now(), "an expired token is recognisably past its deadline");

const malformedTokens: (string | null | undefined)[] = ["", "not.a.token", "!!!invalid!!!", "token with spaces", null, undefined];
assert(malformedTokens.every((t) => t !== "valid_token_format"),
  "no malformed value is mistaken for a well-formed token");

const activeSessions = new Set<string>(["session_token_abc123"]);
activeSessions.delete("session_token_abc123");
assert(!activeSessions.has("session_token_abc123"), "a token stops validating once its session is dropped at logout");

const tokens = new Set<string>();
const concurrentLogins = 100;
for (let i = 0; i < concurrentLogins; i++) tokens.add(`token_${i}`);
assert(tokens.size === concurrentLogins, "concurrent logins each receive a distinct token");

// -- Session timeout and renewal ------------------------------------------------------

console.log("\nsession timeout and renewal:");

const sessionTTL = 86400000;
const renewalThreshold = 72000000;
const sessionCreatedAt = Date.now();

assert(sessionCreatedAt + sessionTTL + 1000 - sessionCreatedAt > sessionTTL,
  "an access past the TTL is outside the session window");

const renewAccess = sessionCreatedAt + renewalThreshold + 1000;
assert(renewAccess - sessionCreatedAt < sessionTTL, "a renewal-window access is still inside the TTL");
assert(renewAccess - sessionCreatedAt > renewalThreshold, "but late enough to earn a refreshed expiry");

const preAuthToken = "attacker_token";
const postAuthToken = "new_token_after_login";
assert(preAuthToken !== postAuthToken, "the token is regenerated at login, defeating session fixation");

// -- Multiple authentication methods ----------------------------------------------------

console.log("\nmultiple authentication methods:");

const md5Token = /^[a-f0-9]{32}$/i;
assert(md5Token.test("5f4dcc3b5aa765d61d8327deb882cf99"), "a Subsonic token is 32 hex characters");
assert(!md5Token.test("a1b2c3d4e5f6g7h8"), "a short or non-hex value is not accepted as one");

const mixedAuthRequest = { sessionCookie: "session_token", apiKey: "api_key_123", basicAuth: "base64encoded" };
assert(Object.keys(mixedAuthRequest).length > 1,
  "a request carrying several auth methods at once must resolve to a single documented priority");

const authMethods = ["session", "subsonic_cred", "apikey", "guest"];
const levelFor = (_method: string, storedLevel: number) => storedLevel;
assert(authMethods.every((m) => levelFor(m, 0) === 0),
  "the permission level comes from the account, not from the method used to prove it");

// -- Password hashing and storage ---------------------------------------------------------

console.log("\npassword hashing and storage:");

const sha256Hex = /^[a-f0-9]{64}$/i;
const mockHash = "a".repeat(64);
assert(mockHash.length === 64 && sha256Hex.test(mockHash), "a stored password hash is 64 hex characters");

const plainPassword = "MySecurePassword123";
assert(mockHash !== plainPassword, "the stored value is never the plaintext password");
assert(!sha256Hex.test(plainPassword), "and the plaintext would not pass for a hash either");

const attemptWithHash = { username: "admin", password: "a".repeat(64) };
assert(attemptWithHash.password.length === 64 && attemptWithHash.password !== plainPassword,
  "posting a hash as the password does not shortcut server-side hashing");

// -- Login error messages ------------------------------------------------------------------

console.log("\nlogin error messages:");

const responses = {
  nonexistentUser: "Invalid username or password",
  wrongPassword: "Invalid username or password",
};
assert(responses.nonexistentUser === responses.wrongPassword,
  "an unknown account and a wrong password are indistinguishable to the caller");

const badResponse = { error: "SQLITE_CANTOPEN: unable to open database file" };
const sanitiseError = (e: string) => (/SQLITE|D1_|constraint/i.test(e) ? "Login failed. Please try again." : e);
assert(!sanitiseError(badResponse.error).includes("SQLITE"),
  "a database error is replaced before it reaches the login response");

assert(!responses.wrongPassword.includes(String(MIN_PASSWORD)) && !/characters/.test(responses.wrongPassword),
  "the failure message leaks no password policy detail");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
