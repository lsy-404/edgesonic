// SPDX-License-Identifier: AGPL-3.0-or-later
import { albumsFromXml, shuffled, tracksFromXml } from "../../web/src/lib/homeMusic";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

console.log("home album data uses server rows only:");
const albums = albumsFromXml([
  { id: "album-1", name: "New record", artist: "The Artist", artistId: "artist-1", coverArt: "cover-1", songCount: "9", year: "2026" },
  { id: "", name: "Unaddressable" },
  { id: "album-2", name: "", artist: "No name" },
]);
assert(albums.length === 1, "invalid or incomplete album rows are excluded");
assert(albums[0].songCount === 9 && albums[0].artistId === "artist-1", "album metadata is retained");

console.log("album playback rows retain reliable fallbacks:");
const tracks = tracksFromXml([
  { id: "song-1", title: "Opening", duration: "245" },
  { id: "song-2", title: "", duration: "180" },
], albums[0]);
assert(tracks.length === 1, "unplayable song rows are excluded");
assert(tracks[0].albumId === "album-1" && tracks[0].coverArt === "cover-1", "track inherits the selected album identity and art");
assert(tracks[0].duration === 245 && tracks[0].artist === "The Artist", "track falls back to album metadata");

console.log("shuffle is non-mutating:");
const original = ["a", "b", "c", "d"];
const shuffledItems = shuffled(original);
assert(original.join(",") === "a,b,c,d", "source queue is not changed");
assert(shuffledItems.length === original.length && [...shuffledItems].sort().join(",") === original.join(","), "shuffle preserves every queued item");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
