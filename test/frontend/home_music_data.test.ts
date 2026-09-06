// SPDX-License-Identifier: AGPL-3.0-or-later
import { albumsFromXml, isSuccessfulSubsonicResponse, loadHomeSections, shuffled, tracksFromXml, type HomeSection } from "../../web/src/lib/homeMusic";

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

  console.log("section loading preserves successful and previously visible sections:");
  const previous = { newest: albums, frequent: [{ ...albums[0], id: "old-frequent" }], recent: [] };
  const result = await loadHomeSections(async (section: HomeSection) => {
    if (section === "frequent") throw new Error("temporary failure");
    return section === "recent" ? [{ id: "recent-1", name: "Recent", artist: "Band" }] : [{ id: "new-1", name: "New", artist: "Band" }];
  }, previous);
  assert(result.albums.newest[0].id === "new-1" && result.albums.recent[0].id === "recent-1", "successful sections update independently");
  assert(result.failed.has("frequent") && result.albums.frequent[0].id === "old-frequent", "failed section keeps existing content for retry");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
void main();
