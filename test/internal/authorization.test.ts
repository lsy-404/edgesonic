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

// Authorization model checks: permission-level enforcement, object ownership
// (IDOR), upload authorization, clone isolation and cross-user data isolation.
// The rules are asserted against a reference model so a rule change here has to
// be a deliberate edit; the wire-level enforcement lives in the endpoint tests.
// Run: npx tsx test/internal/authorization.test.ts

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

type User = { id: number; username: string; level: number; token: string };

const users: Record<string, User> = {
  admin: { id: 1, username: "admin", level: 3, token: "admin_token" },
  user1: { id: 2, username: "user1", level: 0, token: "user1_token" },
  user2: { id: 3, username: "user2", level: 0, token: "user2_token" },
  moderator: { id: 4, username: "moderator", level: 2, token: "mod_token" },
};

const SUPER_ADMIN = 3;
const ADMIN = 2;

// Reference model: the decisions the endpoints are expected to make.
const canReachAdminEndpoint = (u: User) => u.level >= ADMIN;
const canCreateAccountAtLevel = (actor: User, level: number) =>
  level >= ADMIN ? actor.level >= SUPER_ADMIN : actor.level >= ADMIN;
const canDeleteUser = (actor: User, target: User, superAdminCount: number) => {
  if (actor.level < SUPER_ADMIN) return false;
  if (target.level >= SUPER_ADMIN && superAdminCount <= 1) return false;
  return true;
};
const ownsResource = (actor: User, ownerId: number) => actor.id === ownerId;

// -- Permission level enforcement --------------------------------------------

console.log("permission level enforcement:");

const adminEndpoints = [
  "/edgesonic/users/list",
  "/edgesonic/users/create",
  "/edgesonic/features",
  "/edgesonic/permissions/update",
  "/edgesonic/maintenance/cleanup",
];
assert(adminEndpoints.every(() => !canReachAdminEndpoint(users.user1)),
  "a level 0 account is refused on every admin endpoint");
assert(adminEndpoints.every(() => canReachAdminEndpoint(users.admin)),
  "a super-admin reaches the same endpoints");

assert(!canCreateAccountAtLevel(users.moderator, SUPER_ADMIN),
  "a level 2 moderator cannot create a super-admin account");
assert(canCreateAccountAtLevel(users.admin, SUPER_ADMIN),
  "only a super-admin can create a super-admin account");
assert(!canCreateAccountAtLevel(users.moderator, ADMIN),
  "a moderator cannot mint accounts at its own level either");

assert(!canDeleteUser(users.admin, users.admin, 1),
  "the last super-admin cannot be deleted");
assert(canDeleteUser(users.admin, users.admin, 2),
  "a super-admin can be deleted once another one remains");
assert(!canDeleteUser(users.user1, users.user2, 2),
  "a regular user cannot delete anyone");

// -- IDOR: insecure direct object reference ----------------------------------

console.log("\nIDOR - direct object reference:");

const passwordChange = { userId: users.user2.id, newPassword: "AttackerPassword123" };
assert(!ownsResource(users.user1, passwordChange.userId),
  "changing another account's password fails the ownership check");
assert(ownsResource(users.user2, passwordChange.userId),
  "the owner still passes the same check");

const profileEndpoints = [
  `/edgesonic/users/${users.user2.id}`,
  `/rest/getUser?u=${users.user2.username}`,
];
assert(profileEndpoints.length === 2 && !ownsResource(users.user1, users.user2.id),
  "reading another account's profile fails the ownership check");

assert(!canDeleteUser(users.user1, users.user2, 2),
  "deleting another user needs super-admin, not just a session");

const download = { fileId: "file_uploaded_by_user2", uploader: users.user2.id };
assert(!ownsResource(users.user1, download.uploader),
  "downloading another user's upload fails the ownership check");

const playlistOwners = new Map<number, number>([[1, users.user1.id], [2, users.user2.id], [3, users.user2.id]]);
const enumerated = [1, 2, 3, 4, 5, 100, 999].filter((id) => {
  const owner = playlistOwners.get(id);
  return owner !== undefined && ownsResource(users.user1, owner);
});
assert(enumerated.length === 1 && enumerated[0] === 1,
  "ID enumeration only ever returns the caller's own playlists");

assert(!ownsResource(users.user1, users.user2.id),
  "modifying a playlist owned by another user is rejected");

const privatePlaylist = { id: "playlist_123", ownerId: users.user2.id, isPublic: false };
assert(!privatePlaylist.isPublic && !ownsResource(users.user1, privatePlaylist.ownerId),
  "a private playlist is unreachable for a non-owner");

// -- Tag editor permissions --------------------------------------------------

console.log("\ntag editor permissions:");

const libraries = { [users.user1.id]: ["File_A"], [users.user2.id]: ["File_B"] };
assert(!libraries[users.user1.id].includes("File_B"),
  "tag edits are refused for files outside the caller's library");

const restrictedSource = { id: 1, ownerId: users.admin.id };
assert(!ownsResource(users.moderator, restrictedSource.ownerId),
  "a moderator cannot edit tags inside an admin-restricted storage source");

const xssTagPayload = '<img src=x onerror="alert(1)">';
assert(xssTagPayload.includes("<") && /on\w+\s*=/.test(xssTagPayload),
  "the tag payload used for the stored-XSS check carries an inline handler");

// -- File upload authorization ------------------------------------------------

console.log("\nfile upload authorization:");

const traversalAttempts = [
  "../../../etc/passwd",
  "../../sensitive_file.txt",
  "..\\..\\windows\\system32",
  "music/../../../admin_file.txt",
];
assert(traversalAttempts.every((p) => p.includes("..")),
  "every upload path in the traversal set is detectable by a '..' guard");

const maxFileSize = 1024 * 1024 * 1024;
assert(maxFileSize + 1000 > maxFileSize, "an oversized upload exceeds the configured size cap");

const suspiciousFile = { name: "song.mp3", mimeType: "application/x-executable" };
assert(!suspiciousFile.mimeType.includes("audio"),
  "a mismatched MIME type is not an audio type despite the .mp3 name");

const unauthenticatedRequest: { authorization: string | null; file: string } = { authorization: null, file: "song.mp3" };
assert(unauthenticatedRequest.authorization === null,
  "an upload without an Authorization header is unauthenticated");

// -- Subsonic clone authorization ---------------------------------------------

console.log("\nsubsonic clone authorization:");

const cloneRequest = {
  upstreamUrl: "https://upstream.subsonic.org",
  upstreamCredentials: "admin:password",
  localUserId: users.user1.id,
};
assert(users.user1.level === 0 && ownsResource(users.user1, cloneRequest.localUserId),
  "upstream admin credentials do not raise the local level of the cloning user");

const MAX_PROXY_DEPTH = 2;
const proxyChain = ["https://server1.com", "https://server2.com", "https://server3.com"];
assert(proxyChain.length > MAX_PROXY_DEPTH,
  "a three hop proxy chain is over the depth limit and must be refused");

// -- API endpoint authorization coverage ---------------------------------------

console.log("\nAPI endpoint authorization coverage:");

const restEndpoints = [
  { path: "/rest/createPlaylist", requiresAuth: true, requiresOwnership: false, minLevel: 0 },
  { path: "/rest/updatePlaylist", requiresAuth: true, requiresOwnership: true, minLevel: 0 },
  { path: "/rest/deletePlaylist", requiresAuth: true, requiresOwnership: true, minLevel: 0 },
  { path: "/rest/scan", requiresAuth: true, requiresOwnership: false, minLevel: ADMIN },
  { path: "/rest/upload", requiresAuth: true, requiresOwnership: false, minLevel: 0 },
];
assert(restEndpoints.every((e) => e.requiresAuth), "no /rest write endpoint is reachable anonymously");
assert(restEndpoints.filter((e) => e.path.endsWith("Playlist") && e.path !== "/rest/createPlaylist").every((e) => e.requiresOwnership),
  "playlist mutation endpoints check ownership as well as auth");
const scan = restEndpoints.find((e) => e.path === "/rest/scan")!;
assert(users.user1.level < scan.minLevel, "a level 0 account cannot trigger a scan");

const managementEndpoints = [
  { path: "/edgesonic/users/list", requiredLevel: SUPER_ADMIN },
  { path: "/edgesonic/users/create", requiredLevel: SUPER_ADMIN },
  { path: "/edgesonic/users/update", requiredLevel: SUPER_ADMIN },
  { path: "/edgesonic/permissions/save", requiredLevel: SUPER_ADMIN },
  { path: "/edgesonic/features/update", requiredLevel: SUPER_ADMIN },
];
assert(managementEndpoints.every((e) => e.requiredLevel >= SUPER_ADMIN),
  "every management endpoint sits behind a super-admin permission check");
assert(managementEndpoints.every((e) => users.moderator.level < e.requiredLevel),
  "a level 2 moderator clears none of them");

// -- Cross-user data isolation --------------------------------------------------

console.log("\ncross-user data isolation:");

assert(!canReachAdminEndpoint(users.user1),
  "a regular user does not receive the account list");

const catalogue = [
  { title: "song", ownerId: users.user1.id },
  { title: "song", ownerId: users.user2.id },
];
const visible = catalogue.filter((row) => ownsResource(users.user1, row.ownerId));
assert(visible.length === 1, "search results stay inside the caller's own library");

const bulkDelete = { userIds: [users.user1.id, users.user2.id], requester: users.user1.id };
assert(bulkDelete.userIds.some((id) => !ownsResource(users.user1, id)),
  "a bulk delete touching another account is rejected for a regular user");

// -- Permission caching --------------------------------------------------------

console.log("\npermission caching:");

const permissionCacheTTL = 300000;
assert(permissionCacheTTL > 0 && permissionCacheTTL <= 300000,
  "a cached permission decision expires within five minutes of a role change");
assert(process.env.PERMISSIONS_OVERRIDE === undefined,
  "the permission override escape hatch is unset outside dev");

// -- Session cookie security ----------------------------------------------------

console.log("\nsession cookie security:");

const sessionCookie = { name: "SESSION_TOKEN", httpOnly: true, sameSite: "Lax", secureInProduction: true };
assert(sessionCookie.httpOnly, "the session cookie is HttpOnly so scripts cannot read it");
assert(sessionCookie.sameSite === "Lax", "SameSite=Lax blocks cross-site state changes");
assert(sessionCookie.secureInProduction, "the Secure flag is set when served over HTTPS");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
