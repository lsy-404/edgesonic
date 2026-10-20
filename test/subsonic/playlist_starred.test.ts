// SPDX-License-Identifier: AGPL-3.0-or-later
// Playlist details carry the caller's song stars like every other listing.
// Run: pnpm exec tsx test/subsonic/playlist_starred.test.ts

import { mapPlaylistDetail } from "../../worker/src/types/subsonic";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const playlist = { id: "pl", name: "P", owner: "alice", public: 0, song_count: 2, duration: 0, cover_r2_key: null, comment: null, created_at: 0, updated_at: 0 };
const song = (id: string) => ({ id, album_id: "al", artist_id: "ar", title: id, track: 1, disc: 1, duration: 10, genre: null, created_at: 0 }) as never;

console.log("playlist detail stars:");
const detail = mapPlaylistDetail(playlist, [song("s1"), song("s2")],
  new Map([["song:s1", { starred: 1, starred_at: 1700000000, rating: null, play_count: 0 }]]));
assert(!!detail.entries[0].starred, "starred entry reports starred");
assert(!detail.entries[1].starred, "unstarred entry stays unstarred");
assert(!mapPlaylistDetail(playlist, [song("s1")]).entries[0].starred, "callers without annotations are unchanged");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
