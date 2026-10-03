import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { annotationRoutes } from "../../worker/src/endpoints/subsonic/annotation";
import { browsingRoutes } from "../../worker/src/endpoints/subsonic/browsing";
import { createDb, makeD1 } from "../helpers/albumListeningDb";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.UI_TEST_BASE || "http://127.0.0.1:5179";
const output = new URL("../artifacts/home-listening/", import.meta.url);
await mkdir(output, { recursive: true });
const sqlite = createDb();
sqlite.exec(`
  INSERT INTO users(username, master_password, level) VALUES ('browser-fixture', 'fixture', 3);
  INSERT INTO artists(id, name) VALUES ('artist-fixture', 'Fixture artist');
  INSERT INTO albums(id, name, song_count, duration, created_at) VALUES
    ('album-a', 'Listening album A', 2, 12, 100),
    ('album-b', 'Listening album B', 1, 6, 200),
    ('album-c', 'Unplayed album C', 1, 6, 300);
  INSERT INTO song_masters(id, album_id, artist_id, title, track, duration) VALUES
    ('song-a1', 'album-a', 'artist-fixture', 'Listening track A1', 1, 6),
    ('song-a2', 'album-a', 'artist-fixture', 'Listening track A2', 2, 6),
    ('song-b', 'album-b', 'artist-fixture', 'Listening track B', 1, 6),
    ('song-c', 'album-c', 'artist-fixture', 'Unplayed track C', 1, 6);
  INSERT INTO song_instances(id, master_id, source_id, storage_uri, suffix, content_type, duration)
    SELECT 'instance-' || id, id, 'r2-local', 'r2://fixture/' || id || '.wav', 'wav', 'audio/wav', 6
    FROM song_masters;
`);
const app = new Hono<any>();
app.use("*", async (context, next) => {
  context.set("user", { username: "browser-fixture", level: 3, enabled: 1 });
  context.set("authMethod", "session");
  await next();
});
app.route("/rest", annotationRoutes);
app.route("/rest", browsingRoutes);
const env = { DB: makeD1(sqlite) };
const executionContext = { waitUntil(promise: Promise<unknown>) { void promise.catch(() => {}); }, passThroughOnException() {} };
const wav = Buffer.alloc(44 + 8000 * 2 * 6);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--mute-audio"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const permissions = { browse: true, stream: true, search: true, edit_annotations: true };
await context.addInitScript(({ permissions }) => {
  localStorage.setItem("edgesonic_logged_in", "1");
  localStorage.setItem("edgesonic_user", "browser-fixture");
  localStorage.setItem("edgesonic_level", "3");
  localStorage.setItem("edgesonic_lang", "en");
  localStorage.setItem("edgesonic_perms", JSON.stringify({ ...permissions, edit_annotations: !location.search.includes("denied") }));
}, { permissions });
const calls: Array<{ endpoint: string; type: string | null; id: string | null; time: string | null }> = [];
let failSubmission = false;
let canReport = true;
await context.route("**/*", async (route: any) => {
  const request = route.request();
  const url = new URL(request.url());
  const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  if (url.pathname.startsWith("/rest/")) {
    const endpoint = url.pathname.split("/").pop()!.replace(/\.view$/, "");
    calls.push({ endpoint, type: url.searchParams.get("type"), id: url.searchParams.get("id"), time: url.searchParams.get("time") });
    if (endpoint === "stream") return route.fulfill({ contentType: "audio/wav", body: wav });
    if (endpoint === "getCoverArt") return route.fulfill({ status: 204, body: "" });
    if (endpoint === "scrobble" && failSubmission) {
      failSubmission = false;
      return route.fulfill({ status: 503, body: "Temporary fixture failure" });
    }
    if (["getAlbumList2", "getAlbum", "getSong", "scrobble"].includes(endpoint)) {
      const response = await app.fetch(new Request(url, { method: request.method() }), env, executionContext as any);
      return route.fulfill({ status: response.status, contentType: "application/xml", body: await response.text() });
    }
    return route.fulfill({ contentType: "application/xml", body: '<subsonic-response status="ok" version="1.16.1"/>' });
  }
  if (url.pathname.startsWith("/edgesonic/")) {
    if (url.pathname.endsWith("/auth/me")) return json({ ok: true, username: "browser-fixture", level: 3, permissions: { ...permissions, edit_annotations: canReport } });
    if (url.pathname.endsWith("/stats/library")) return json({ ok: true, ready: true, stale: false, artists: 1, albums: 3, songs: 4 });
    if (url.pathname.endsWith("/album-display-groups")) return json({ ok: true, groups: [] });
    if (url.pathname.endsWith("/features")) return json({ ok: true, features: {} });
    if (url.pathname.endsWith("/messages")) return json({ ok: true, messages: [], unread: 0 });
    return json({ ok: true });
  }
  if (url.origin !== base) return route.abort();
  return route.continue();
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error: Error) => errors.push(error.message));
const section = (title: string) => page.locator(".album-section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const playAlbum = (name: string) => section("New additions").getByRole("button", { name: `Play ${name}`, exact: true }).click();
const count = (id: string) => Number((sqlite.prepare("SELECT COALESCE(SUM(play_count), 0) AS count FROM annotations WHERE item_type='song' AND item_id=?").get(id) as any).count);
async function waitCount(id: string, expected: number) {
  const deadline = Date.now() + 15000;
  while (count(id) !== expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(count(id), expected, `persisted actual listening count for ${id}`);
}
async function pause() {
  if (/pause/i.test(await page.locator(".pb-play").getAttribute("title") || "")) await page.locator(".pb-play").click();
}
async function expectOrder(title: string, names: string[]) {
  await page.waitForFunction(({ title, names }) => {
    const section = [...document.querySelectorAll(".album-section")].find(section => section.querySelector("h2")?.textContent === title);
    return JSON.stringify([...section?.querySelectorAll(".album-name") || []].map(element => element.textContent?.trim())) === JSON.stringify(names);
  }, { title, names });
}
try {
  await page.goto(`${base}/#/`);
  await expectOrder("New additions", ["Unplayed album C", "Listening album B", "Listening album A"]);
  await expectOrder("Popular albums", []);
  await expectOrder("Recently played", []);
  await section("Recently played").locator(".section-empty").waitFor();
  const newestRequests = calls.filter(call => call.endpoint === "getAlbumList2" && call.type === "newest").length;
  for (const expected of [1, 2]) {
    await playAlbum("Listening album A");
    await waitCount("song-a1", expected);
    await pause();
    await expectOrder("Popular albums", ["Listening album A"]);
    await expectOrder("Recently played", ["Listening album A"]);
    assert.equal(count("song-a2"), 0, "speculative preload does not create listening records");
  }
  await playAlbum("Listening album B");
  await waitCount("song-b", 1);
  await pause();
  await expectOrder("Popular albums", ["Listening album A", "Listening album B"]);
  await expectOrder("Recently played", ["Listening album B", "Listening album A"]);
  assert.equal(calls.filter(call => call.endpoint === "getAlbumList2" && call.type === "newest").length, newestRequests, "listening refresh only reloads the two affected sections");
  await page.waitForTimeout(500);
  assert.equal(count("song-b"), 1, "pause does not submit another play");
  const submitted = calls.filter(call => call.endpoint === "scrobble");
  assert.equal(submitted.length, 3);
  assert.ok(submitted.every(call => Number(call.time) > 1_000_000_000_000), "scrobble timestamps use milliseconds");
  await page.reload();
  await expectOrder("Popular albums", ["Listening album A", "Listening album B"]);
  await expectOrder("Recently played", ["Listening album B", "Listening album A"]);
  assert.equal(count("song-a1"), 2, "history survives page reload without another completed play");
  failSubmission = true;
  await playAlbum("Unplayed album C");
  await page.waitForFunction(() => Number(document.querySelector(".pb-title")?.textContent?.includes("Unplayed track C")) && document.querySelector(".pb-progress") !== null);
  await page.waitForTimeout(4200);
  assert.equal(failSubmission, false, "failed report was attempted");
  assert.equal(count("song-c"), 0, "failed response does not create a play");
  assert.match(await page.locator(".pb-play").getAttribute("title") || "", /pause/i, "reporting failure does not stop playback");
  await pause();
  await expectOrder("Popular albums", ["Listening album A", "Listening album B"]);
  canReport = false;
  await page.goto(`${base}/?denied=1#/`);
  await expectOrder("New additions", ["Unplayed album C", "Listening album B", "Listening album A"]);
  const previousSubmissions = calls.filter(call => call.endpoint === "scrobble").length;
  await playAlbum("Unplayed album C");
  await page.waitForTimeout(4200);
  await pause();
  assert.equal(calls.filter(call => call.endpoint === "scrobble").length, previousSubmissions, "disabled annotation permission sends no play report");
  assert.equal(count("song-c"), 0);
  await page.screenshot({ path: fileURLToPath(new URL("home-listening.png", output)), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Actual audio playback -> Subsonic scrobble -> SQLite song history -> live home album ranking, repeat, preload, persistence, failure and permissions passed.");
} finally {
  await browser.close();
  sqlite.close();
}
