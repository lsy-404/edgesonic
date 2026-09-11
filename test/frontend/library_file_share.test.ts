// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/frontend/library_file_share.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const root = join(__dirname, "../..");
const library = readFileSync(join(root, "web/src/views/Library.vue"), "utf8");
const songMenu = readFileSync(join(root, "web/src/components/SongRowMenu.vue"), "utf8");
const files = readFileSync(join(root, "web/src/views/Files.vue"), "utf8");
const playlists = readFileSync(join(root, "web/src/views/Playlists.vue"), "utf8");
const shareDialog = readFileSync(join(root, "web/src/components/ShareDialog.vue"), "utf8");

console.log("search drilldown, file location and page sharing:");
assert(/@click="openAlbum\(al\)"/.test(library), "search album drilldown keeps the search route state");
assert(!/@click="openAlbum\(al\); clearSearch\(\)"/.test(library), "search album drilldown does not clear the query");
assert(/authFetch\("getSong", \{ id: song\.id, includeSources: "true" \}\)/.test(library), "file location resolves the selected song's physical source");
assert(/router\.push\(\{ path: "\/files", query: \{ source, path: folder, file: fileName \} \}\)/.test(library), "file location opens the containing folder and file");
assert(/canManageFiles/.test(library) && /:can-manage-files="canManageFiles"/.test(library), "file location is passed through the file-management capability");
assert(/canManageFiles: boolean/.test(songMenu), "song menu declares the file-management capability");
assert(/v-if="props\.canManageFiles"[\s\S]*library\.viewInFiles/.test(songMenu), "song menu hides View in Files without permission");
assert(/@view-file="openSongInFiles\(s\)"/.test(library), "library rows handle View in Files");

console.log("share entry points:");
assert(/starredOnly && canShare/.test(library) && /starredLists\.songs\.map/.test(library), "Liked page shares its liked songs");
assert(/openFolderShare/.test(files) && /files\.share/.test(files), "Files page shares the current folder");
assert(/openSelectedShare/.test(files) && /files\.shareSelected/.test(files), "Files page can share selected files");
assert(/canShare && entries\.length/.test(playlists) && /openPlaylistShare/.test(playlists), "Playlist detail shares its entries");
assert(/createShare/.test(shareDialog) && /id: uniqueSongIds\.value/.test(shareDialog), "shared dialog submits all selected song ids");
assert(/expiresNever/.test(shareDialog) && /datetime-local/.test(shareDialog), "shared dialog keeps expiry options");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
