import { buildLibrarySearchParams, buildLibrarySearchRoute, LIBRARY_PAGE_SIZES, paginateLibraryItems } from "../../web/src/lib/librarySearch";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

console.log("Library lyrics search parameters:");
assert(LIBRARY_PAGE_SIZES.join(",") === "20,50,100,200,500", "Library offers every requested page size");
const slice = paginateLibraryItems(Array.from({ length: 53 }, (_, index) => index), 2, 20);
assert(slice.items[0] === 20 && slice.items.at(-1) === 39 && slice.hasPrevious && slice.hasNext, "client pages slice at the requested boundary");
assert(paginateLibraryItems([1, 2, 3], 8, 2).page === 2, "client pages clamp after filtering removes trailing rows");
const normal = buildLibrarySearchParams("artist", "", "nameDesc", 20);
assert(!("lyricsQuery" in normal), "blank lyrics input does not add lyricsQuery");
assert(normal.query === "artist" && normal.artistCount === "21" && normal.albumCount === "21", "normal search requests one artist and album lookahead");
assert(normal.songSort === "titleDesc", "normal search carries the selected song sort");
assert(normal.artistOffset === "0" && normal.albumOffset === "0" && normal.songOffset === "0", "first search page starts at offset zero");

const lyrics = buildLibrarySearchParams("", "  moonlight  ", "newest");
assert(lyrics.lyricsQuery === "moonlight", "lyrics query is trimmed before sending");
assert(lyrics.artistCount === "0" && lyrics.albumCount === "0" && lyrics.songCount === "101", "lyrics search requests songs only with a lookahead row");
assert(lyrics.query === "", "lyrics-only search leaves the regular query empty");

const later = buildLibrarySearchParams("x", "", "newest", 500, { artists: 3, albums: 2, songs: 4 });
assert(later.artistCount === "500" && later.albumCount === "500" && later.songCount === "500", "500-item pages stay within the worker limit and use a separate lookahead request");
assert(later.artistOffset === "1000" && later.albumOffset === "500" && later.songOffset === "1500", "each search category receives its page offset");

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
assert(library.includes("ensureSearchSongs") && library.includes("isInstrumentalTitle(song.title)"), "search paging fills visible pages after instrumental filtering");
assert(library.includes("ensureAlbumItems") && library.includes("pagedAlbumDisplayCards"), "album paging works over grouped display cards");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
