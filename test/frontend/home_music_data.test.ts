// SPDX-License-Identifier: AGPL-3.0-or-later
import { albumsFromXml, isSuccessfulSubsonicResponse, shuffled, tracksFromXml } from "../../web/src/lib/homeMusic";

let failures = 0;
function assert(condition: unknown, message: string) { if (condition) console.log(`  ✓ ${message}`); else { failures++; console.error(`  ✗ ${message}`); } }

async function main() {
  console.log("home album data uses server rows only:");
  const albums = albumsFromXml([{ id: "album-1", name: "New record", artist: "The Artist", artistId: "artist-1", coverArt: "cover-1", songCount: "9", year: "2026" }, { id: "", name: "Unaddressable" }]);
  assert(albums.length === 1 && albums[0].songCount === 9, "invalid album rows are excluded while metadata remains");
  const tracks = tracksFromXml([{ id: "song-1", title: "Opening", duration: "245" }, { id: "song-2", title: "" }], albums[0]);
  assert(tracks.length === 1 && tracks[0].albumId === "album-1" && tracks[0].coverArt === "cover-1", "playable tracks inherit selected album metadata");
  const original = ["a", "b", "c", "d"]; const shuffledItems = shuffled(original);
  assert(original.join(",") === "a,b,c,d" && [...shuffledItems].sort().join(",") === original.join(","), "shuffle preserves and does not mutate the source queue");

  console.log("Subsonic response validation rejects non-data responses:");
  assert(isSuccessfulSubsonicResponse('<subsonic-response status="ok"><albumList2 /></subsonic-response>'), "valid success response is accepted");
  assert(!isSuccessfulSubsonicResponse('<subsonic-response status="failed"><error message="no" /></subsonic-response>'), "protocol error is rejected");
  assert(!isSuccessfulSubsonicResponse("<html>gateway error</html>"), "non-Subsonic error page is rejected");

  const favorite = tracksFromXml([{ id: "saved", title: "Saved", starred: "2026-09-06T00:00:00Z", created: "2026-09-01T00:00:00Z" }], albums[0])[0];
  assert(favorite.starred === true && favorite.starredAt === "2026-09-06T00:00:00Z" && favorite.createdAt === "2026-09-01T00:00:00Z", "home playback keeps favorite and creation metadata");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
void main();
