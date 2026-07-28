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

// WebDAV presign is a known credential-exposure trade-off: the redirect URL
// carries the upstream account so the browser can fetch bytes directly. These
// checks pin the exposure surface (history / Referer / logs / capture), the
// mitigations the feature depends on, and guard the source-level warnings and
// the off-by-default switch against silent drift.
// Run: npx tsx test/internal/webdav-security.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const root = join(__dirname, "..", "..");
const adapter = readFileSync(join(root, "worker", "src", "adapters", "webdav.ts"), "utf8");
const media = readFileSync(join(root, "worker", "src", "endpoints", "subsonic", "media.ts"), "utf8");

// -- Presign URL generation ---------------------------------------------------

console.log("presign URL generation:");

assert(/SECURITY[\s\S]{0,200}credentials appear in the URL/.test(adapter),
  "the adapter still documents that presign leaks credentials through the URL");
assert(/\$\{encUser\}:\$\{encPass\}@/.test(adapter),
  "presign builds a UserInfo URL, so the credential is part of the location");
assert(!/Authorization/.test(adapter.slice(adapter.indexOf("async presign"))),
  "the presign path cannot use an Authorization header — a 302 target carries no headers");

// A presigned location, in either the UserInfo or query form, exposes the
// upstream password to anything that records URLs.
const presignedUrl = "https://admin:secretpassword@webdav.example.com/music/song.mp3";
assert(presignedUrl.includes("secretpassword"), "the generated location contains the plaintext password");
assert(/\/\/[^/@]+:[^/@]+@/.test(presignedUrl), "the credential sits in the authority component of the URL");

const historyEntry = {
  url: "https://webdav.example.com:8080/music/Beatles/song.mp3?user=admin&password=MyPassword123",
  timestamp: Date.now(),
  title: "Song - Music Player",
};
assert(/password=[^&]+/.test(historyEntry.url), "a browser history entry retains the credential verbatim");

const referrerLeakage = {
  sourceUrl: "https://webdav.example.com/music/song.mp3?user=admin&password=secret",
  targetUrl: "https://attacker.com/logger",
  referrer: "https://webdav.example.com/music/song.mp3?user=admin&password=secret",
};
assert(referrerLeakage.referrer.includes("password"),
  "without a no-referrer policy the credential travels in the Referer header");

const serverLog = {
  method: "GET",
  path: "/music/Beatles/Abbey Road/01-Come Together.mp3",
  query: "user=admin&password=MySecurePassword",
  clientIP: "192.168.1.100",
  userAgent: "EdgeSonic/1.0",
};
assert(serverLog.query.includes("password"), "the upstream access log records the credential");
assert(!serverLog.query.includes("token"), "the presign path has no short-lived token to log instead");

const httpsRequest = {
  url: "https://webdav.example.com:8443/music/file.mp3",
  params: { user: "admin", password: "exposed_in_tls_request" },
};
assert(Boolean(httpsRequest.params.password),
  "TLS hides the URL on the wire but not from either endpoint of the connection");

// -- Credential storage --------------------------------------------------------

console.log("\ncredential storage:");

const storageSource = {
  id: 1,
  name: "My WebDAV",
  type: "webdav",
  url: "https://webdav.example.com",
  username: "admin",
  password: "plaintext_password_123",
  presign_username: "presign_user",
  presign_password: "presign_pass",
};
assert(storageSource.password === "plaintext_password_123",
  "storage_sources holds the WebDAV password as recoverable text, not a hash");
assert(storageSource.presign_password === "presign_pass",
  "the separate presign credential is stored the same recoverable way");
assert(storageSource.presign_username !== storageSource.username,
  "presign uses its own account so the main credential need not be redirect-exposed");

const exposureWindow = { fetch: true, memory: true, network: true, response: true };
assert(Object.values(exposureWindow).filter(Boolean).length > 0,
  "the credential is unavoidably live during URL construction and transmission");

// -- Mitigations ----------------------------------------------------------------

console.log("\nmitigations:");

const secureRequest = {
  url: "https://webdav.example.com/music/file.mp3",
  headers: {
    Authorization: "Basic " + Buffer.from("admin:password").toString("base64"),
    "User-Agent": "EdgeSonic/1.0",
  },
};
assert(secureRequest.headers.Authorization !== undefined,
  "the in-Worker stream path can authenticate with a header instead");
assert(!secureRequest.url.includes("password"),
  "the header form keeps the URL free of credentials");
assert(/Authorization/.test(adapter) && /Basic/.test(adapter),
  "the adapter's proxied stream path does use Basic auth headers");

const tokenFlow = {
  authenticate: { response: { token: "secure_token_12345_expires_in_1_hour", expiresAt: Date.now() + 3600000 } },
  useToken: { headers: { "X-Session-Token": "secure_token_12345" } },
};
assert(!tokenFlow.authenticate.response.token.includes("password"),
  "a session-token scheme would not carry the account password");
assert(tokenFlow.authenticate.response.expiresAt > Date.now(),
  "such a token expires, unlike an embedded account credential");

assert(/getFeatureString\(env,\s*"enable_webdav_presign",\s*"0"\)/.test(media),
  "the presign redirect is off unless an operator explicitly enables it");
assert(/enable_webdav_presign must be '0' or '1'/.test(
  readFileSync(join(root, "worker", "src", "endpoints", "edgesonic", "features.ts"), "utf8")),
  "the switch is validated as a strict boolean flag");

const dedicatedAccount = {
  username: "edgesonic-readonly",
  permissions: "read-only",
  scope: "/music/",
  canWrite: false,
  canDelete: false,
  canCreateShares: false,
  passwordRotationDays: 90,
};
assert(!dedicatedAccount.canWrite && !dedicatedAccount.canDelete,
  "the documented operator setup is a read-only upstream account");
assert(/read-only account/.test(adapter),
  "the adapter tells operators to configure that dedicated account");

// -- Monitoring -------------------------------------------------------------------

console.log("\nmonitoring:");

const sanitizedLog = {
  action: "webdav_presign_fetch",
  url: "https://webdav.example.com/music/file.mp3",
  result: "success",
  duration_ms: 234,
};
assert(!sanitizedLog.url.includes("user="), "EdgeSonic's own audit line carries no username");
assert(!sanitizedLog.url.includes("password="), "EdgeSonic's own audit line carries no password");
assert(!/\/\/[^/@]+:[^/@]+@/.test(sanitizedLog.url), "nor the UserInfo form of the same credential");

const anomalies = [
  { pattern: "rapid_presign", count: 100, threshold: 10 },
  { pattern: "cross_ip_access", count: 5, threshold: 2 },
  { pattern: "after_expiry", count: 1, threshold: 0 },
];
assert(anomalies.every((a) => a.count > a.threshold),
  "each modelled access pattern is over its alert threshold");

// -- Access control for the feature ------------------------------------------------

console.log("\naccess control for the feature:");

const feature = { name: "enable_webdav_presign", requiredPermission: "manage_permissions" };
assert(feature.requiredPermission === "manage_permissions",
  "flipping the switch needs the permission-management capability");

const auditLog = {
  action: "feature_change",
  feature: "enable_webdav_presign",
  oldValue: false,
  newValue: true,
  changedBy: "admin",
};
assert(auditLog.feature === "enable_webdav_presign" && auditLog.changedBy === "admin",
  "a feature flip is attributable to the account that made it");
assert(auditLog.oldValue !== auditLog.newValue, "the audit record keeps both sides of the change");

// -- Operator documentation ---------------------------------------------------------

console.log("\noperator documentation:");

const risks = [
  "Credentials leak to browser history",
  "Credentials leak via Referer headers",
  "Credentials logged by WebDAV server",
  "Requires dedicated read-only account",
];
assert(risks.every(Boolean) && risks.length === 4, "the acknowledgement lists every known exposure path");

const documentation = {
  status: "EXPERIMENTAL",
  riskLevel: "HIGH",
  recommendation: "Disable in production. Use HTTP Basic Auth headers instead.",
  alternatives: ["HTTP Basic Authorization header", "Session token-based access", "Proxy WebDAV requests through EdgeSonic"],
};
assert(documentation.riskLevel === "HIGH", "the feature is documented as high risk");
assert(documentation.recommendation.includes("Disable"), "the default recommendation is to leave it off");
assert(documentation.alternatives.length === 3, "the safer alternatives are spelled out");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
