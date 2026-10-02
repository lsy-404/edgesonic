import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.UI_TEST_BASE || "http://127.0.0.1:5179";
const output = new URL("../artifacts/library-interface/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--mute-audio"] });
const permissions = Object.fromEntries(["browse", "manage_credentials", "manage_settings", "manage_files", "manage_sources", "share", "participate_work", "maintenance_reclaim"].map(key => [key, true]));
const xml = body => `<?xml version="1.0"?><subsonic-response status="ok" version="1.16.1">${body}</subsonic-response>`;
const songs = Array.from({ length: 1121 }, (_, index) => ({ id: `song-${index + 1}`, title: `Track ${String(index + 1).padStart(4, "0")}${index % 5 === 0 ? " (Instrumental)" : ""}`, artist: "Test artist", album: "Test album", albumId: "album-1", artistId: "artist-1", duration: "180", created: "2026-10-01T00:00:00Z" }));
const artists = Array.from({ length: 63 }, (_, index) => ({ id: `artist-${index + 1}`, name: `Artist ${index + 1}`, albumCount: "1" }));
const albums = Array.from({ length: 121 }, (_, index) => ({ id: `album-${index + 1}`, name: `Album ${index + 1}`, artist: "Test artist", songCount: "12", year: "2026" }));
const element = (tag, attributes) => `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`).join(" ")}/>`;
const silentAudio = Buffer.alloc(44 + 8000 * 2 * 180);
silentAudio.write("RIFF");
silentAudio.writeUInt32LE(silentAudio.length - 8, 4);
silentAudio.write("WAVEfmt ", 8);
silentAudio.writeUInt32LE(16, 16);
silentAudio.writeUInt16LE(1, 20);
silentAudio.writeUInt16LE(1, 22);
silentAudio.writeUInt32LE(8000, 24);
silentAudio.writeUInt32LE(16000, 28);
silentAudio.writeUInt16LE(2, 32);
silentAudio.writeUInt16LE(16, 34);
silentAudio.write("data", 36);
silentAudio.writeUInt32LE(silentAudio.length - 44, 40);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(({ permissions }) => {
  localStorage.setItem("edgesonic_logged_in", "1");
  localStorage.setItem("edgesonic_user", "test-account");
  localStorage.setItem("edgesonic_level", "3");
  if (new URLSearchParams(location.search).has("cold")) localStorage.removeItem("edgesonic_perms");
  else localStorage.setItem("edgesonic_perms", JSON.stringify(new URLSearchParams(location.search).has("denied") ? { ...permissions, manage_credentials: false } : permissions));
  localStorage.setItem("edgesonic_lang", "en");
}, { permissions });
const calls = [];
let credentials = [];
let clientPermission = true;
let meDelay = 0;
let songLimit = songs.length;
let statsReady = true;
let statsStale = false;
let blockSongRequest = null;
let releaseSongRequest = null;
let blockedQuery = null;
let failNextSongPage = false;
let failNextSongPageQuery = "";
let failedPageBody = "Temporary test failure";
const credentialCalls = [];
await context.route("**/*", async route => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const json = value => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
  const sendXml = body => route.fulfill({ contentType: "application/xml", body: xml(body) });
  if (path.startsWith("/rest/")) {
    const endpoint = path.split("/").pop().replace(/\.view$/, "");
    calls.push({ endpoint, query: url.searchParams.get("query"), count: Number(url.searchParams.get("songCount")), offset: Number(url.searchParams.get("songOffset")) });
    if (endpoint === "search3") {
      const query = (url.searchParams.get("query") || "").toLowerCase();
      const selected = songs.slice(0, songLimit).filter(song => !query || song.title.toLowerCase().includes(query));
      if (query === failNextSongPageQuery && Number(url.searchParams.get("songCount")) > 0 && Number(url.searchParams.get("songOffset")) > 0 && failNextSongPage) {
        failNextSongPage = false;
        return route.fulfill({ status: 503, contentType: "text/plain", body: failedPageBody });
      }
      if (blockSongRequest && ((!query && Number(url.searchParams.get("songOffset")) >= 200) || (query === blockedQuery && Number(url.searchParams.get("songOffset")) > 0))) {
        const blocked = blockSongRequest;
        blockSongRequest = null;
        await new Promise(resolve => { releaseSongRequest = resolve; blocked(); });
      }
      const bucket = (items, tag) => {
        const offset = Number(url.searchParams.get(`${tag}Offset`));
        const count = Math.min(500, Number(url.searchParams.get(`${tag}Count`) || 20));
        return items.slice(offset, offset + count).map(item => element(tag, item)).join("");
      };
      return sendXml(`<searchResult3>${bucket(artists.filter(artist => !query || artist.name.toLowerCase().includes(query)), "artist")}${bucket(albums.filter(album => !query || album.name.toLowerCase().includes(query)), "album")}${bucket(selected, "song")}</searchResult3>`);
    }
    if (endpoint === "getArtists") return sendXml(`<artists><index name="A">${artists.map(item => element("artist", item)).join("")}</index></artists>`);
    if (endpoint === "getAlbumList2") {
      const offset = Number(url.searchParams.get("offset"));
      const count = Math.min(500, Number(url.searchParams.get("size") || 20));
      return sendXml(`<albumList2>${albums.slice(offset, offset + count).map(item => element("album", item)).join("")}</albumList2>`);
    }
    if (endpoint === "getStarred2") return sendXml(`<starred2>${artists.slice(0, 23).map(item => element("artist", { ...item, starred: "2026-10-01" })).join("")}${albums.slice(0, 31).map(item => element("album", { ...item, starred: "2026-10-01" })).join("")}${songs.slice(0, 83).map(item => element("song", { ...item, starred: "2026-10-01" })).join("")}</starred2>`);
    if (endpoint === "getAlbum") return sendXml(`<album id="album-1" name="Test album" artist="Test artist">${songs.slice(0, 12).map(item => element("song", item)).join("")}</album>`);
    if (endpoint === "getLyricsBySongId") return sendXml(`<lyricsList><structuredLyrics synced="true">${Array.from({ length: 30 }, (_, i) => `<line start="${i * 5000}">Test lyric line ${i + 1}</line>`).join("")}</structuredLyrics></lyricsList>`);
    if (endpoint === "stream") return route.fulfill({ contentType: "audio/wav", body: silentAudio });
    if (endpoint === "getCoverArt") return route.fulfill({ status: 204, body: "" });
    return sendXml("");
  }
  if (path.startsWith("/edgesonic/")) {
    if (path.endsWith("/stats/library")) return json({ ok: true, ready: statsReady, stale: statsStale, artists: artists.length, albums: albums.length, songs: songLimit, updatedAt: 1790812800 });
    if (path.endsWith("/auth/me")) {
      if (meDelay) await new Promise(resolve => setTimeout(resolve, meDelay));
      return json({ ok: true, username: "test-account", level: 3, permissions: { ...permissions, manage_credentials: clientPermission } });
    }
    if (path.includes("/auth/credentials/")) credentialCalls.push(path.split("/").pop());
    if (path.endsWith("/album-display-groups")) return json({ ok: true, groups: [{ id: "group-1", name: "Grouped editions", memberAlbumIds: ["album-1", "album-51", "album-101"], memberCount: 3 }] });
    if (path.endsWith("/auth/credentials/list")) return sendXml(`<credentials>${credentials.map(item => element("credential", item)).join("")}</credentials>`);
    if (path.endsWith("/auth/credentials/create")) {
      const payload = request.postDataJSON();
      assert.equal(payload.password.length, 20);
      credentials.push({ id: "credential-1", label: payload.label, createdAt: 1790812800, lastUsed: 0, streamProxyStrategy: "always" });
      return sendXml("");
    }
    if (path.endsWith("/auth/credentials/delete")) { credentials = []; return sendXml(""); }
    if (path.endsWith("/auth/credentials/update")) return sendXml("");
    if (path.endsWith("/auth/sessions/list")) return sendXml("<sessions/>");
    if (path.endsWith("/features")) return json({ ok: true, features: {} });
    if (path.endsWith("/messages")) return json({ ok: true, messages: [], unread: 0 });
    return json({ ok: true });
  }
  return route.continue();
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
async function waitCount(selector, count) {
  await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector, count });
  assert.equal(await page.locator(selector).count(), count);
}
async function snapshot(name) {
  await settleLayout();
  await page.mouse.move(1000, 10);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)), fullPage: true });
}
async function settleLayout() {
  await page.waitForFunction(() => !document.querySelector(".page-next-enter-active,.page-previous-enter-active,.page-next-leave-active,.page-previous-leave-active,.detail-sheet-enter-active,.detail-sheet-leave-active"));
  await page.evaluate(() => Promise.all([...document.querySelectorAll(".sidebar-selection")].flatMap(element => element.getAnimations()).map(animation => animation.finished.catch(() => {}))));
}
async function noHorizontalOverflow() {
  await settleLayout();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page fits the viewport horizontally");
}
async function choosePageSize(value) {
  await page.getByRole("combobox", { name: "Items per page", exact: true }).click();
  await page.getByRole("option", { name: String(value), exact: true }).click();
}
async function changePage(direction, section = page.locator(".library-pagination").last()) {
  const control = section.getByRole("button", { name: direction, exact: true });
  await page.waitForFunction(element => element && !element.disabled, await control.elementHandle());
  await control.click();
}
async function chooseLoadMode(automatic) {
  await page.getByRole("combobox", { name: "Loading", exact: true }).click();
  await page.getByRole("option", { name: automatic ? "Automatic loading" : "Manual pages", exact: true }).click();
}
async function jumpToPage(value) {
  const input = page.getByRole("spinbutton", { name: /Jump to page/ }).last();
  await input.fill(String(value));
  await input.press("Enter");
}
async function scrollToBottom() {
  return page.locator(".main").evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
}

try {
  await page.goto(`${base}/#/library`);
  await waitCount(".song-row", 50);
  assert.ok(calls.filter(call => call.endpoint === "search3").length <= 2, "initial page fetch stays bounded");
  for (const reset of ["size", "sort"]) {
    songLimit = 210;
    await page.reload();
    await waitCount(".song-row", 50);
    await changePage("Next");
    await changePage("Next");
    await changePage("Next");
    const blocked = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Delayed pagination request was not reached")), 30000);
      blockSongRequest = () => { clearTimeout(deadline); resolve(); };
    });
    await changePage("Next");
    await blocked;
    if (reset === "size") await choosePageSize(20);
    else {
      await page.locator(".sort-select").click();
      await page.getByRole("option", { name: "Oldest added", exact: true }).click();
    }
    releaseSongRequest();
    await page.locator(".load-more").waitFor({ state: "hidden" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(".song-row").first().getAttribute("data-song-id"), "song-1", `${reset} reset survives a stale page response`);
    assert.match(await page.locator(".library-pagination > .mono-label").last().textContent(), /^Page 1(?:\b|$)/);
  }
  songLimit = songs.length;
  await page.reload();
  await waitCount(".song-row", 50);
  await page.getByText("Page 1 of 23", { exact: true }).waitFor();
  await jumpToPage(23);
  await waitCount(".song-row", 21);
  assert.equal(await page.locator(".song-row").first().getAttribute("data-song-id"), "song-1101");
  assert.ok(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
  await jumpToPage(1);
  await waitCount(".song-row", 50);
  for (const value of ["", "9999"]) {
    await jumpToPage(value);
    assert.equal(await page.locator(".song-row").first().getAttribute("data-song-id"), "song-1", "invalid page jumps leave the current page intact");
  }
  for (const snapshot of [{ ready: true, stale: true }, { ready: false, stale: false }]) {
    statsReady = snapshot.ready;
    statsStale = snapshot.stale;
    await page.reload();
    await waitCount(".song-row", 50);
    await page.getByText("Page 1 · at least 2 pages", { exact: true }).waitFor();
    assert.equal(await page.getByRole("spinbutton", { name: /Jump to page/ }).count(), 0, "unknown totals do not expose an exact page limit");
  }
  statsReady = true;
  statsStale = false;
  await page.reload();
  await waitCount(".song-row", 50);
  await choosePageSize(20);
  await waitCount(".song-row", 20);
  await changePage("Next");
  await page.locator('.song-row[data-song-id="song-21"]').waitFor();
  await waitCount(".song-row", 20);
  for (const size of [100, 200, 500]) {
    await choosePageSize(size);
    await waitCount(".song-row", size);
    assert.equal(await page.locator(".song-row").first().getAttribute("data-song-id"), "song-1");
  }
  await changePage("Next");
  await page.locator('.song-row[data-song-id="song-501"]').waitFor();
  await waitCount(".song-row", 500);
  await changePage("Next");
  await waitCount(".song-row", 121);
  assert.equal(await page.locator(".song-row").first().getAttribute("data-song-id"), "song-1001");
  assert.ok(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
  await choosePageSize(20);
  await page.locator(".list-options-btn").click();
  await page.getByRole("switch", { name: "Hide instrumentals", exact: true }).click();
  await page.locator("#library-search").click();
  await waitCount(".song-row", 20);
  assert.ok(!(await page.locator(".song-title").allTextContents()).some(title => title.includes("Instrumental")));
  await page.locator("#library-search").fill("Track");
  await page.locator(".search-results .song-row").first().waitFor();
  await waitCount(".song-row", 20);
  const firstSearch = await page.locator(".search-results .song-title").allTextContents();
  await changePage("Next");
  await page.waitForFunction(first => document.querySelector(".search-results .song-title")?.textContent !== first, firstSearch[0]);
  await waitCount(".song-row", 20);
  const nextSearch = await page.locator(".search-results .song-title").allTextContents();
  assert.ok(nextSearch.every(title => !firstSearch.includes(title) && !title.includes("Instrumental")));
  await choosePageSize(500);
  await waitCount(".song-row", 500);
  await changePage("Next");
  await waitCount(".song-row", 396);
  assert.ok(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
  await page.locator("#library-search").fill("");
  await page.locator(".search-results").waitFor({ state: "hidden" });
  await choosePageSize(20);
  await page.locator(".list-options-btn").click();
  await page.getByRole("switch", { name: "Hide instrumentals", exact: true }).click();
  await page.locator("#library-search").click();
  await page.getByRole("button", { name: "Artists", exact: true }).click();
  await waitCount(".artist-card", 20);
  for (let index = 0; index < 3; index++) await changePage("Next");
  await waitCount(".artist-card", 3);
  assert.ok(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await waitCount(".album-card", 20);
  const albumNames = [];
  for (let index = 0; index < 6; index++) {
    await waitCount(".album-card", index === 5 ? 19 : 20);
    albumNames.push(...await page.locator(".album-name").allTextContents());
    if (index < 5) {
      const oldName = await page.locator(".album-name").first().textContent();
      await changePage("Next");
      await page.waitForFunction(name => document.querySelector(".album-name")?.textContent !== name, oldName);
    }
  }
  assert.equal(new Set(albumNames).size, 119, "album display groups are emitted once across page boundaries");
  assert.ok(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
  await page.getByText("Page 6 of 6", { exact: true }).waitFor();
  await page.reload();
  await waitCount(".song-row", 50);
  await choosePageSize(20);
  await waitCount(".song-row", 20);
  await chooseLoadMode(true);
  failNextSongPage = true;
  await scrollToBottom();
  await waitCount(".song-row", 40);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await scrollToBottom();
  await page.getByRole("button", { name: /^retry$/i }).waitFor({ timeout: 10000 }).catch(async error => {
    console.error("Automatic failure state", { rows: await page.locator(".song-row").count(), failNextSongPage, calls: calls.filter(call => call.endpoint === "search3").slice(-5), state: await page.locator(".main").evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, clientHeight: element.clientHeight, text: element.innerText.slice(-600) })) });
    throw error;
  });
  assert.equal(await page.locator(".song-row").count(), 40, "failed automatic page retains the existing results");
  await page.getByRole("button", { name: /^retry$/i }).click();
  await waitCount(".song-row", 60);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  failedPageBody = "";
  failNextSongPage = true;
  await scrollToBottom();
  await page.getByRole("button", { name: /^retry$/i }).waitFor();
  assert.equal(await page.locator(".song-row").count(), 60, "an empty failed response does not become an empty last page");
  await page.getByRole("button", { name: /^retry$/i }).click();
  await waitCount(".song-row", 80);
  failedPageBody = "Temporary test failure";
  await chooseLoadMode(false);
  await jumpToPage(1);
  await waitCount(".song-row", 20);
  await page.reload();
  await waitCount(".song-row", 50);
  await choosePageSize(20);
  await waitCount(".song-row", 20);
  await chooseLoadMode(true);
  const scrolledBeforeAppend = await scrollToBottom();
  await waitCount(".song-row", 40);
  assert.ok(await page.locator(".main").evaluate(element => element.scrollTop) >= scrolledBeforeAppend - 2, "automatic loading preserves the scrolled position");
  const appendedIds = await page.locator(".song-row").evaluateAll(rows => rows.map(row => row.dataset.songId));
  assert.equal(new Set(appendedIds).size, 40);
  assert.equal(appendedIds[0], "song-1");
  assert.equal(appendedIds[20], "song-21");
  const appendedTitle = await page.locator(".song-row .song-title").nth(25).textContent();
  await page.locator(".song-row .song-title").nth(25).click();
  await page.waitForFunction(title => document.querySelector(".pb-title")?.textContent === title, appendedTitle);
  await page.reload();
  await waitCount(".song-row", 50);
  assert.ok((await page.getByRole("combobox", { name: "Loading", exact: true }).textContent()).includes("Automatic loading"), "loading preference survives reload");
  await choosePageSize(20);
  await waitCount(".song-row", 20);
  blockedQuery = "track";
  await page.locator("#library-search").fill("Track");
  await waitCount(".search-results .song-row", 20);
  failNextSongPageQuery = "track";
  failNextSongPage = true;
  await scrollToBottom();
  await page.getByRole("button", { name: /^retry$/i }).waitFor();
  assert.equal(await page.locator(".search-results .song-row").count(), 20, "failed search continuation retains the current results");
  await page.getByRole("button", { name: /^retry$/i }).click();
  await waitCount(".search-results .song-row", 40);
  await page.reload();
  await waitCount(".song-row", 50);
  await choosePageSize(20);
  await waitCount(".song-row", 20);
  const pendingSearch = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Delayed search page was not reached")), 30000);
    blockSongRequest = () => { clearTimeout(deadline); resolve(); };
  });
  await page.locator("#library-search").fill("Track");
  await waitCount(".search-results .song-row", 20);
  const searchScroll = await scrollToBottom();
  await pendingSearch;
  assert.equal(await page.locator(".search-results .song-row").count(), 20, "pending search page keeps previous results mounted");
  assert.ok(await page.locator(".main").evaluate(element => element.scrollTop) >= searchScroll - 2, "pending search page preserves the scroll anchor");
  releaseSongRequest();
  blockedQuery = null;
  await waitCount(".search-results .song-row", 40);
  assert.equal(await page.locator(".search-results .song-row .song-title").first().textContent(), songs[0].title);
  await chooseLoadMode(false);
  await waitCount(".search-results .song-row", 20);
  await page.locator("#library-search").fill("Artist");
  await waitCount(".search-results .artist-card", 20);
  await chooseLoadMode(true);
  await scrollToBottom();
  await waitCount(".search-results .artist-card", 40);
  assert.equal(new Set(await page.locator(".search-results .artist-name").allTextContents()).size, 40, "artist search appends each result once");
  await chooseLoadMode(false);
  await page.locator("#library-search").fill("");
  await page.locator(".search-results").waitFor({ state: "hidden" });
  await page.goto(`${base}/#/starred`);
  await waitCount(".song-row", 50);
  await choosePageSize(20);
  for (let index = 0; index < 4; index++) await changePage("Next");
  await waitCount(".song-row", 3);
  assert.ok(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
  const starredSelection = await page.locator(".song-row .song-title").first().textContent();
  await page.locator(".song-row .song-title").first().click();
  await page.waitForFunction(title => document.querySelector(".pb-title")?.textContent === title, starredSelection);
  await page.goto(`${base}/#/library`);
  await waitCount(".song-row", 50);
  await snapshot("library-desktop");
  await page.locator(".song-row .song-title").first().click();
  await page.locator(".pb-track").click();
  await page.locator(".detail-host .fluent-scroll-viewer").waitFor();
  assert.equal(await page.locator(".detail-host__close").evaluate(element => getComputedStyle(element).getPropertyValue("--fluent-radius").trim()), "4px");
  await snapshot("viewer-desktop");
  for (const viewport of [{ width: 1100, height: 600 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await noHorizontalOverflow();
    const fits = await page.locator(".detail-host").evaluate(element => {
      const body = element.querySelector(".detail-host__body").getBoundingClientRect();
      const info = element.querySelector(".np-track-info").getBoundingClientRect();
      return info.bottom <= body.bottom + 1 && info.top >= body.top - 1;
    });
    assert.ok(fits, "viewer track metadata remains inside the available height");
    await snapshot(viewport.width < 500 ? "viewer-mobile" : "viewer-short");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".detail-host__close").click();
  await page.locator(".detail-host").waitFor({ state: "hidden" });
  await page.goto(`${base}/#/subsonic-clients`);
  await page.locator(".connection-detail").first().waitFor();
  assert.equal(await page.locator(".connection-detail code").first().textContent(), base);
  assert.equal(await page.locator(".setup-steps").count(), 0);
  assert.equal(await page.getByRole("link", { name: "Clients", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Create client password", exact: true }).count(), 1);
  assert.ok(!(await page.locator(".clients-page").textContent()).includes("file management"));
  const recommendations = page.locator(".recommended-clients");
  assert.equal(await recommendations.getAttribute("open"), null);
  assert.ok(await recommendations.locator("a").first().isHidden());
  await recommendations.locator("summary").focus();
  await page.keyboard.press("Enter");
  await recommendations.locator("a").first().waitFor({ state: "visible" });
  assert.deepEqual(await recommendations.locator("a").evaluateAll(links => links.map(link => link.href)), [
    "https://music.aqzscn.cn/docs/intro/", "https://www.symfonium.app/", "https://ultrasonic.gitlab.io/", "https://github.com/supersonic-app/supersonic",
  ]);
  assert.ok(await recommendations.locator("a").evaluateAll(links => links.every(link => link.target === "_blank" && link.rel.includes("noopener"))));
  await page.keyboard.press("Enter");
  assert.equal(await recommendations.getAttribute("open"), null);
  await snapshot("clients-desktop");
  await page.locator(".cred-label-field input").fill("Music app");
  await page.getByRole("button", { name: "Create client password", exact: true }).click();
  await page.locator(".issued-password-row code").waitFor();
  assert.equal((await page.locator(".issued-password-row code").textContent()).length, 20);
  await waitCount(".credential-card", 1);
  const listCalls = credentialCalls.filter(call => call === "list").length;
  meDelay = 350;
  await page.goto(`${base}/?cold=1#/subsonic-clients`);
  await waitCount(".credential-card", 1);
  assert.ok(credentialCalls.filter(call => call === "list").length > listCalls, "cold permission cache loads credentials after auth hydration");
  assert.equal(await page.locator(".issued-panel").count(), 0, "generated password is not restored after reload");
  meDelay = 0;
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await waitCount(".credential-card", 0);
  assert.equal(credentials.length, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow();
  await snapshot("clients-mobile");
  for (const route of ["settings", "tools"]) {
    await page.goto(`${base}/#/${route}`);
    await page.waitForFunction(title => document.querySelector(".page-title")?.textContent.trim() === title, route === "settings" ? "Settings" : "Tools");
    await page.locator(".settings-section").first().waitFor();
    const headers = page.locator(".section-header");
    for (const header of await headers.all()) {
      const panelId = await header.getAttribute("aria-controls");
      assert.ok(panelId, "expander header names its controlled panel");
      assert.equal(await page.locator(`[id="${panelId}"]`).count(), 1);
      assert.ok(["true", "false"].includes(await header.getAttribute("aria-expanded")));
      assert.ok(await header.locator(".section-icon svg").evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width >= 18 && bounds.height >= 18 && style.padding === "0px";
      }), "category icon remains legible inside its wrapper");
    }
    const keyboardHeader = headers.first();
    const wasExpanded = await keyboardHeader.getAttribute("aria-expanded");
    await keyboardHeader.focus();
    await page.keyboard.press("Space");
    assert.equal(await keyboardHeader.getAttribute("aria-expanded"), wasExpanded === "true" ? "false" : "true");
    await page.keyboard.press("Enter");
    assert.equal(await keyboardHeader.getAttribute("aria-expanded"), wasExpanded);
    if (route === "settings") {
      const systemHeader = page.locator('[aria-controls="settings-panel-system"]');
      await systemHeader.click();
      const nestedHeaders = page.locator(".sub-section-header");
      assert.equal(await nestedHeaders.count(), 6);
      for (const header of await nestedHeaders.all()) {
        assert.equal(await header.getAttribute("aria-expanded"), "false");
        const panelId = await header.getAttribute("aria-controls");
        assert.ok(panelId);
        assert.equal(await page.locator(`[id="${panelId}"]`).count(), 1);
      }
      await nestedHeaders.first().focus();
      await page.keyboard.press("Enter");
      assert.equal(await nestedHeaders.first().getAttribute("aria-expanded"), "true");
      assert.equal(await systemHeader.getAttribute("aria-expanded"), "true");
      const nestedPanelId = await nestedHeaders.first().getAttribute("aria-controls");
      assert.ok(await page.locator(`[id="${nestedPanelId}"]`).isVisible());
      await noHorizontalOverflow();
      await snapshot("settings-nested-mobile");
      await page.keyboard.press("Enter");
    } else {
      await page.locator('.tools [aria-controls="tools-panel-migrate"]').click();
      await page.locator("#tools-panel-migrate").waitFor({ state: "visible" });
    }
    await noHorizontalOverflow();
    assert.equal(await page.locator("#subsonic-clients").count(), 0);
    await snapshot(`${route}-mobile`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await noHorizontalOverflow();
    await snapshot(`${route}-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
  }
  clientPermission = false;
  const beforeDenied = credentialCalls.length;
  await page.goto(`${base}/?denied=1#/subsonic-clients`);
  await page.waitForURL(url => url.hash === "#/");
  assert.equal(await page.locator(".cred-create").count(), 0);
  assert.equal(credentialCalls.length, beforeDenied, "denied route never requests credentials");
  assert.deepEqual(errors, []);
  console.log("Library page sizes, boundaries, search filtering, grouped albums, liked playback, Fluent viewer layouts, client credentials, permissions, and responsive settings/tools passed.");
} finally {
  await browser.close();
}
