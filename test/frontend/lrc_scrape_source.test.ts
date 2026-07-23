import { resolve, search } from "../../web/src/lib/scrape/lrc";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log(`  OK ${message}`);
  else {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/albums.json")) {
    return Response.json({
      albums: [{
        slug: "demo_album", name: "Demo Album", year: "2026-01-02",
        produce: ["Producer"], vocal: ["Vocal"], cover: "/albums/demo.png",
        songs: [{ title: "First Song" }],
      }],
    });
  }
  if (url.endsWith("/albums/demo_album.json")) {
    return Response.json({
      slug: "demo_album", name: "Demo Album", year: "2026-01-02",
      produce: ["Producer"], vocal: ["Vocal"], composer: ["Composer"], lyricist: ["Lyricist"],
      cover: "/albums/demo.png",
      songs: [{ title: "First Song", lyrics: [{ time: 1.25, text: "First line" }, { time: 62, text: "Second line" }] }],
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const proxy = async () => { throw new Error("proxy should not be used"); };

void (async () => {
  try {
    const results = await search("First Song Producer", proxy as never);
    assert(results.length === 1, "album index matches the selected track and album metadata");
    const result = await resolve(results[0], proxy as never);
    assert(result.artist === "Vocal" && result.albumArtist === "Producer", "detail credits populate artist and album artist");
    assert(result.lyrics === "[00:01.25]First line\n[01:02.00]Second line", "detail timestamps convert to LRC");
    assert(result.coverUrl === "https://lrc.wuyilingwei.com/albums/demo.png", "detail cover becomes an absolute URL");
  } catch (error) {
    failures++;
    console.error(`  FAIL LRC scrape source: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    globalThis.fetch = originalFetch;
    if (failures > 0) process.exitCode = 1;
  }
})();
