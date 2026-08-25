// SPDX-License-Identifier: AGPL-3.0-or-later

import { search as searchNetEase } from "../../web/src/lib/scrape/netease";
import { resolveResult, searchAll } from "../../web/src/lib/scrape";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log(`  OK ${message}`);
  else { failures++; console.error(`  FAIL ${message}`); }
}

const originalFetch = globalThis.fetch;
const calls: string[] = [];
globalThis.fetch = async (input) => {
  calls.push(`direct:${String(input)}`);
  return Response.json({ result: { songs: [{ id: 3, name: "Direct", artists: [{ name: "Artist" }] }] } });
};

void (async () => {
  try {
    const proxied = await searchNetEase("Artist Direct", async () => {
      calls.push("proxy");
      return { ok: true, data: { result: { songs: [{ id: 1, name: "Proxy", artists: [{ name: "Artist" }] }] } } };
    });
    assert(calls[0] === "proxy", "NetEase uses Worker proxy before browser fetch");
    assert(proxied[0]?.title === "Proxy", "NetEase parses standard Worker payload");
    calls.length = 0;
    const fallback = await searchNetEase("fallback", async () => { calls.push("proxy"); return { ok: false, error: "upstream" }; });
    assert(calls[0] === "proxy" && calls[1]?.startsWith("direct:"), "direct fetch is attempted only after proxy failure");
    assert(fallback[0]?.title === "Direct", "direct fallback remains functional");
    calls.length = 0;
    const started: string[] = [];
    const ranked = await searchAll({
      query: "Target Artist",
      sources: ["netease", "qmusic"],
      proxyFetch: async (request) => {
        started.push(request.source);
        if (request.source === "netease") return { ok: true, data: { result: { songs: [{ id: 4, name: "Other", artists: [{ name: "Artist" }] }] } } };
        return { ok: true, data: { data: { song: { list: [{ songmid: "mid", songname: "Target", singer: [{ name: "Artist" }] }] } } } };
      },
    });
    assert(started.includes("netease") && started.includes("qmusic"), "searchAll fans out every enabled source");
    assert(ranked.results[0]?.title === "Target", "searchAll ranks the global result set by match quality");
    const albumRanked = await searchAll({
      query: "Target Artist",
      current: { title: "Target", artist: "Artist", album: "Target Album" },
      sources: ["netease", "qmusic"],
      proxyFetch: async (request) => request.source === "netease"
        ? { ok: true, data: { result: { songs: [{ id: 5, name: "Target", artists: [{ name: "Artist" }], album: { name: "Wrong Album" } }] } } }
        : { ok: true, data: { data: { song: { list: [{ songmid: "album-mid", songname: "Target", singer: [{ name: "Artist" }], albumname: "Target Album" }] } } } },
    });
    assert(albumRanked.results[0]?.album === "Target Album", "current album breaks cross-source ties by field match rather than provider order");
    const detailed = await resolveResult({ source: "netease", songId: "1", title: "Target", artist: "Artist" }, async (request) => {
      if (request.intent === "detail") return { ok: true, data: { songs: [{ id: 1, name: "Target", artists: [{ name: "Artist" }], album: { name: "Target Album", picUrl: "https://img.example/cover.jpg", publishTime: 725846400000, artists: [{ name: "Album Artist" }] } }] } };
      return { ok: true, data: { lrc: { lyric: "[00:01.00]Resolved lyric" } } };
    });
    assert(detailed.coverUrl === "https://img.example/cover.jpg" && detailed.lyrics?.includes("Resolved lyric"), "NetEase detail resolves cover and lyric through the Worker proxy");
    assert(detailed.albumArtist === "Album Artist", "NetEase detail resolves album artist for per-field apply");
  } catch (error) { failures++; console.error(`  FAIL scrape proxy behavior: ${error instanceof Error ? error.message : String(error)}`); }
  finally { globalThis.fetch = originalFetch; if (failures) process.exitCode = 1; }
})();
