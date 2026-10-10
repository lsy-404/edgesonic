import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = fileURLToPath(new URL('./player_controls_browser.html', import.meta.url));
let browser;
before(async () => { browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' }); });
after(async () => { await browser?.close(); });

async function openFixture({ library = false, mutation } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const favorites = new Set();
  const reads = [];
  const changes = [];
  const song = (id) => `<song id="${id}" title="${id}" artist="Test artist" album="Test album" albumId="test-album" duration="120"${favorites.has(id) ? ' starred="2026-10-09T00:00:00Z"' : ''}/>`;
  await page.addInitScript(() => {
    localStorage.setItem('edgesonic_logged_in', '1');
    localStorage.setItem('edgesonic_user', 'test-account');
    localStorage.setItem('edgesonic_lang', 'en');
    localStorage.setItem('edgesonic_perms', JSON.stringify({ edit_annotations: true }));
  });
  await page.route('**/rest/**', async (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.split('/').pop();
    const id = url.searchParams.get('id');
    let body = '';
    if (endpoint === 'getSong') { reads.push(id); body = song(id); }
    if (endpoint === 'search3') body = `<searchResult3>${Number(url.searchParams.get('songOffset') || 0) === 0 ? song('test') + song('other') : ''}</searchResult3>`;
    if (endpoint === 'getStarred2') body = `<starred2>${[...favorites].map(song).join('')}</starred2>`;
    if (endpoint === 'getAlbum') body = `<album id="test-album" name="Test album" artist="Test artist">${song('test')}</album>`;
    if (endpoint === 'star' || endpoint === 'unstar') {
      changes.push({ endpoint, id });
      const response = mutation ? await mutation() : '<subsonic-response status="ok"/>';
      if (response.includes('status="ok"')) {
        if (endpoint === 'star') favorites.add(id);
        else favorites.delete(id);
      }
      return route.fulfill({ contentType: 'application/xml', body: response });
    }
    return route.fulfill({ contentType: 'application/xml', body: `<subsonic-response status="ok">${body}</subsonic-response>` });
  });
  await page.route(url => url.pathname.startsWith('/edgesonic/'), route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ready: true, stale: false, songs: 2, groups: [] }) }));
  await page.goto(`${process.env.WEB_BASE_URL || 'http://127.0.0.1:5187'}/@fs${fixture}${library ? '?library=1' : ''}`);
  await page.waitForFunction(() => !!window.player?.current);
  await page.waitForFunction(() => window.player.starred === false);
  return { page, reads, changes };
}

async function settle(locator) {
  await locator.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
}

test('favorite and mode presses preserve centering on desktop and expanded mobile', async () => {
  const { page } = await openFixture();
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) await page.evaluate(() => window.detail.openNowPlaying());
      for (const theme of ['black', 'white']) {
        await page.evaluate(async theme => window.setTheme(theme), theme);
        for (const selector of ['.pb-fav', '.pb-mode']) {
          const button = page.locator(selector);
          await settle(button);
          await button.hover();
          const resting = await button.boundingBox();
          await page.mouse.down();
          await settle(button);
          const pressed = await button.boundingBox();
          await page.mouse.up();
          assert.ok(Math.abs(pressed.y - resting.y - 1) < 0.5, `${selector} moves only 1px at ${width}px in ${theme}; observed ${pressed.y - resting.y}px`);
          await settle(button);
        }
      }
    }
  } finally { await page.close(); }
});

test('favorite changes propagate between player, song list, and album detail', async () => {
  const { page } = await openFixture({ library: true });
  try {
    const main = page.locator('#library-main .song-row .star-button').first();
    const detail = page.locator('#library-detail .song-row .star-button').first();
    await main.waitFor();
    await detail.waitFor();
    await page.locator('.pb-fav').press('Enter');
    await page.waitForFunction(() => document.querySelector('#library-main .song-row .star-button')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await detail.getAttribute('aria-pressed'), 'true', 'album detail reflects the player favorite');
    assert.equal(await page.locator('.pb-fav').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.pb-fav svg').getAttribute('fill'), 'currentColor');
    await detail.click();
    await page.waitForFunction(() => window.player.starred === false);
    assert.equal(await main.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.pb-fav').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.pb-fav svg').getAttribute('fill'), 'none');
  } finally { await page.close(); }
});

test('returning to a track keeps its saved favorite instead of stale metadata', async () => {
  const { page, reads } = await openFixture();
  try {
    await page.evaluate(() => window.player.toggleStar());
    await page.evaluate(() => { window.player.queue.push({ id: 'other', title: 'Other', duration: 120 }); window.player.index = 1; });
    await page.waitForFunction(() => window.player.starred === false);
    await page.evaluate(() => { window.player.index = 0; });
    await page.waitForFunction(() => window.player.current?.id === 'test');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.player.starred), true);
    assert.ok(reads.filter(id => id === 'test').length >= 2, 'mutable favorite state is refreshed on track re-entry');
  } finally { await page.close(); }
});

test('pending favorite changes reject duplicate input and failed responses restore the UI', async () => {
  let release;
  let markRequested;
  const requested = new Promise(resolve => { markRequested = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const { page, changes } = await openFixture({ mutation: () => { markRequested(); return response; } });
  try {
    const favorite = page.locator('.pb-fav');
    await favorite.press('Enter');
    await requested;
    try {
      assert.equal(await favorite.isDisabled(), true, 'disable the favorite until the save completes');
      await favorite.evaluate(button => { button.click(); button.click(); });
      assert.equal(changes.length, 1);
    } finally {
      release('<subsonic-response status="failed"><error code="50" message="Save failed"/></subsonic-response>');
    }
    await page.waitForFunction(() => !window.player.starBusy);
    assert.equal(await favorite.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.player.queue[0].starred), false);
    assert.equal(await favorite.isDisabled(), false);
  } finally { await page.close(); }
});


test('the liked view refreshes after the server confirms a favorite save', async () => {
  let release;
  let markRequested;
  const requested = new Promise(resolve => { markRequested = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const { page } = await openFixture({ library: true, mutation: () => { markRequested(); return response; } });
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('#library-starred .empty-state')].some(el => !el.textContent.includes('Loading')));
    await page.locator('.pb-fav').press('Enter');
    await requested;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    release('<subsonic-response status="ok"/>');
    const liked = page.locator('#library-starred .song-row .star-button').first();
    await liked.waitFor();
    assert.equal(await liked.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.pb-fav').getAttribute('aria-pressed'), 'true');
  } finally { release('<subsonic-response status="ok"/>'); await page.close(); }
});
