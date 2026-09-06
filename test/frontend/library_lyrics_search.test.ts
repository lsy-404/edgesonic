import { buildLibrarySearchParams, buildLibrarySearchRoute } from "../../web/src/lib/librarySearch";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

console.log("Library lyrics search parameters:");
const normal = buildLibrarySearchParams("artist", "", "nameDesc");
assert(!("lyricsQuery" in normal), "blank lyrics input does not add lyricsQuery");
assert(normal.query === "artist" && normal.artistCount === "20" && normal.albumCount === "20", "normal search keeps artist and album results");
assert(normal.songSort === "titleDesc", "normal search carries the selected song sort");

const lyrics = buildLibrarySearchParams("", "  moonlight  ", "newest");
assert(lyrics.lyricsQuery === "moonlight", "lyrics query is trimmed before sending");
assert(lyrics.artistCount === "0" && lyrics.albumCount === "0" && lyrics.songCount === "100", "lyrics search requests songs only");
assert(lyrics.query === "", "lyrics-only search leaves the regular query empty");

const restored = buildLibrarySearchRoute({ tab: "songs", q: "old", lyrics: "old lyric" }, "new", "new lyric");
assert(restored.q === "new" && restored.lyrics === "new lyric" && restored.tab === "songs", "route updates atomically preserve both search conditions");
const cleared = buildLibrarySearchRoute(restored, "", "");
assert(!("q" in cleared) && !("lyrics" in cleared) && cleared.tab === "songs", "clearing search removes both route conditions together");

const library = readFileSync(join(__dirname, "..", "..", "web", "src", "views", "Library.vue"), "utf8");
assert(library.includes("searchProtocolError") && library.includes("lyricsSearchPreparing"), "protocol preparation errors stay retryable instead of becoming no results");
assert(library.includes("searchController?.abort()"), "replacing a search aborts the previous request");
assert(library.includes("void runSearch(searchQuery.value.trim(), lyricsQuery.value.trim())"), "sorting an active search re-requests both conditions");
assert(library.includes('document.getElementById("library-lyrics-search")?.focus()'), "opening extended search focuses the lyrics input");
assert(library.includes("runSearch(query, \"\")"), "artist lookup ignores the lyrics condition");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
