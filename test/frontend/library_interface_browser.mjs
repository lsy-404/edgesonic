import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.UI_TEST_BASE || "http://127.0.0.1:5179";
const output = new URL("../artifacts/library-interface/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--mute-audio"] });
const permissions = Object.fromEntries(["manage_credentials", "manage_settings", "manage_files", "manage_sources", "share", "participate_work"].map(key => [key, true]));
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
let blockSongRequest = null;
let releaseSongRequest = null;
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
      if (!query && Number(url.searchParams.get("songOffset")) >= 200 && blockSongRequest) {
        const blocked = blockSongRequest;
        blockSongRequest = null;
        await new Promise(resolve => { releaseSongRequest = resolve; blocked(); });
      }
      const bucket = (items, tag) => {
        const offset = Number(url.searchParams.get(`${tag}Offset`));
        const count = Math.min(500, Number(url.searchParams.get(`${tag}Count`) || 20));
        return items.slice(offset, offset + count).map(item => element(tag, item)).join("");
      };
      return sendXml(`<searchResult3>${bucket(query ? [] : artists, "artist")}${bucket(query ? [] : albums, "album")}${bucket(selected, "song")}</searchResult3>`);
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
    assert.equal(await page.locator(".library-pagination .mono-label").last().textContent(), "Page 1");
  }
  songLimit = songs.length;
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
  assert.equal(await page.locator(".setup-steps li").count(), 4);
  assert.equal(await page.getByRole("link", { name: "Subsonic Clients", exact: true }).count(), 1);
  await snapshot("clients-desktop");
  await page.locator(".cred-label-field input").fill("Music app");
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
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
    if (route === "tools") {
      await page.locator(".tools .section-header").first().click();
      await page.locator(".tools .section-body").first().waitFor({ state: "visible" });
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
