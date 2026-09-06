import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.chdir(new URL("../..", import.meta.url).pathname);
function localSql(sql) {
  const result = spawnSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "d1", "execute", "edgesonic-search-local",
    "--config", "test/extended-search/wrangler.jsonc", "--local",
    "--persist-to", "test/extended-search/.wrangler/state", "--command", sql,
  ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
}

const base = "http://127.0.0.1:8798";
const login = await fetch(`${base}/edgesonic/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "search-test", password: "lyrics-preview" }),
});
assert.equal(login.status, 200, "fixture login succeeds in workerd");
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "login provides a session cookie");

async function call(endpoint, params = {}, method = "GET", useCookie = true) {
  const query = new URLSearchParams({ f: "json", v: "1.16.1", c: "SearchSmoke", ...params });
  const headers = useCookie ? { Cookie: cookie } : {};
  const response = await fetch(`${base}/rest/${endpoint}${method === "GET" ? `?${query}` : ""}`, {
    method, headers: method === "GET" ? headers : { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    ...(method === "POST" ? { body: query.toString() } : {}),
  });
  const data = await response.json();
  return { response, body: data["subsonic-response"] };
}

async function search(params, endpoint = "search3", method = "GET") {
  const result = await call(endpoint, { query: "", ...params }, method);
  assert.equal(result.response.status, 200, "search HTTP status");
  assert.equal(result.body.status, "ok", "search protocol status");
  return result.body[endpoint.startsWith("search2") ? "searchResult2" : "searchResult3"];
}

const ids = (result) => (result.song ?? []).map((song) => song.id);
const denied = await call("search3", { query: "", lyricsQuery: "雨" }, "GET", false);
assert.equal(denied.body.status, "failed", "lyrics search requires authentication");
const extensions = await call("getOpenSubsonicExtensions", {}, "GET", false);
assert.ok(extensions.body.openSubsonicExtensions.some((extension) => extension.name === "edgeSonicExtendedSearch"), "extension is discoverable");

assert.deepEqual(ids(await search({ query: "细雨" })), ["lyric-title"], "normal search still searches titles");
assert.deepEqual(ids(await search({ query: "细雨", lyricsQuery: "  " })), ["lyric-title"], "blank optional parameter preserves standard behavior");
localSql(`INSERT OR REPLACE INTO song_masters(id,title,album_id,artist_id,lyrics)
  SELECT 'warmup-' || value, '初始化样本', 'search-album', 'search-artist', '初始化样本'
  FROM json_each('${JSON.stringify(Array.from({ length: 25 }, (_, index) => index))}')`);
let preparationObserved = false;
for (let attempt = 0; attempt < 8; attempt++) {
  const warm = await call("search3", { query: "", lyricsQuery: "雨" });
  if (warm.response.status === 200) break;
  assert.equal(warm.response.status, 503, "initialization is explicitly retryable");
  preparationObserved = true;
  assert.equal(warm.body.error.message, "edgeSonicLyricsSearchInitializing");
  assert.equal(warm.response.headers.get("retry-after"), "5");
}
assert.equal(preparationObserved, true, "bounded preparation is visible through the real protocol");
localSql("DELETE FROM song_masters WHERE id LIKE 'warmup-%'");
const tooLong = await call("search3", { query: "", lyricsQuery: "x".repeat(513) });
assert.equal(tooLong.response.status, 400);
assert.equal(tooLong.body.error.code, 10);
for (const [query, expected] of [
  ["雨", ["lyric-rain"]], ["细雨", ["lyric-rain"]],
  ["NORTHERN LIGHT", ["lyric-rain"]], ["星空", ["lyric-rich"]],
  ["100%", ["lyric-literal"]], ["_", ["lyric-literal"]],
  ["格式字段不应命中", []], ["' OR 1=1 --", []],
]) {
  const result = await search({ lyricsQuery: query });
  assert.deepEqual(ids(result), expected, `literal indexed lyrics: ${query}`);
  assert.deepEqual(result.artist ?? [], [], "lyrics search omits unrelated artists");
  assert.deepEqual(result.album ?? [], [], "lyrics search omits unrelated albums");
}
assert.deepEqual(ids(await search({ query: "夜色", lyricsQuery: "细雨" })), ["lyric-rain"], "metadata and lyrics filters intersect");
assert.deepEqual(ids(await search({ query: "细雨", lyricsQuery: "细雨" })), [], "matching metadata alone cannot bypass lyrics filter");
assert.deepEqual(ids(await search({ lyricsQuery: "细雨" }, "search2.view", "POST")), ["lyric-rain"], "search2 form POST view suffix");
assert.deepEqual(ids(await search({ lyricsQuery: "细雨" }, "search3.view", "POST")), ["lyric-rain"], "search3 form POST view suffix");
assert.deepEqual(ids(await search({ lyricsQuery: "e", songCount: "1", songSort: "newest" })), ["lyric-literal"], "newest page is sorted in the database");
assert.deepEqual(ids(await search({ lyricsQuery: "e", songCount: "1", songOffset: "1", songSort: "newest" })), ["lyric-rain"], "offset returns the next indexed match");
assert.deepEqual(ids(await search({ lyricsQuery: "e", songCount: "0" })), [], "zero song count is honored");
assert.deepEqual(ids(await search({ lyricsQuery: "e", songSort: "title" })), ["lyric-rain", "lyric-literal"], "title ordering retains SQLite collation");

const xml = await fetch(`${base}/rest/search3.view?query=&lyricsQuery=${encodeURIComponent("细雨")}`, { headers: { Cookie: cookie } });
assert.ok((await xml.text()).includes('id="lyric-rain"'), "XML format returns the same song");
const starred = await call("star", { id: "lyric-rain" }, "POST");
assert.equal(starred.body.status, "ok");
assert.ok((await search({ lyricsQuery: "细雨" })).song[0].starred, "search carries saved user annotations");
assert.equal((await call("unstar", { id: "lyric-rain" }, "POST")).body.status, "ok");
const audio = await fetch(`${base}/rest/stream?id=lyric-rain`, { headers: { Cookie: cookie, Range: "bytes=0-43" } });
assert.equal(audio.status, 206, "a matched song remains playable with ranged media retrieval");
assert.equal(Buffer.from(await audio.arrayBuffer()).toString("ascii", 0, 4), "RIFF");
console.log("PASS: authenticated workerd/D1 indexed search, JSON/XML, GET/POST, paging, annotations and playback.");
