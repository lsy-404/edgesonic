// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = fileURLToPath(new URL('./player_controls_browser.html', import.meta.url));
const audio = Buffer.alloc(44 + 60 * 8000 * 2);
audio.write('RIFF', 0);
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24);
audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(audio.length - 44, 40);
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); });

async function openQueue(index = 1, mode = 'sequential') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    localStorage.setItem('edgesonic_lang', 'en');
    const NativeAudio = window.Audio;
    window.queueAudio = [];
    window.Audio = class extends NativeAudio {
      constructor(...args) { super(...args); window.queueAudio.push(this); }
    };
  });
  await page.route('**/queue-audio/*.wav', route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const start = Number(range?.[1] ?? 0);
    const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    return route.fulfill({
      status: range ? 206 : 200, contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {}) },
      body: audio.subarray(start, end + 1),
    });
  });
  await page.route('**/rest/**', route => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get('id');
    const body = url.pathname.endsWith('/getSong') ? `<song id="${id}" title="${id}" artist="Artist" duration="60"/>` : '';
    return route.fulfill({ contentType: 'application/xml', body: `<subsonic-response status="ok">${body}</subsonic-response>` });
  });
  await page.route(url => url.pathname.startsWith('/edgesonic/'), route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(`${process.env.WEB_BASE_URL || 'http://127.0.0.1:5187'}/@fs${fixture}`);
  await page.waitForFunction(() => !!window.player && !!window.setTheme);
  await page.evaluate(({ index, mode }) => {
    window.player.playMode = mode;
    window.player.setQueue(['a', 'b', 'c'].map(id => ({ id, title: id, artist: 'Artist', duration: 60, streamUrl: new URL(`/queue-audio/${id}.wav`, location.href).href })), index);
  }, { index, mode });
  await playingTrack(page, ['a', 'b', 'c'][index]);
  await page.locator('.pb-queue-btn').click();
  return page;
}

async function playingTrack(page, id) {
  await page.waitForFunction(id => window.player.current?.id === id && window.player.playing && window.queueAudio.some(el => el.currentSrc.endsWith(`/queue-audio/${id}.wav`) && !el.paused && el.readyState >= 2), id);
}
async function state(page) {
  return page.evaluate(() => ({ ids: window.player.queue.map(track => track.id), current: window.player.current?.id ?? null, index: window.player.index }));
}

test('queue remove hover remains circular in dark, light, themed, and narrow layouts', async () => {
  const page = await openQueue();
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['black', 'white', 'sp-ark']) {
        await page.evaluate(theme => window.setTheme(theme), theme);
        const button = page.locator('.pb-queue-rm').last();
        await button.hover();
        const shape = await button.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const icon = el.querySelector('svg').getBoundingClientRect();
          return { width: rect.width, height: rect.height, radius: style.borderRadius, background: style.backgroundColor, centered: Math.abs(icon.x + icon.width / 2 - rect.x - rect.width / 2) < 0.5 && Math.abs(icon.y + icon.height / 2 - rect.y - rect.height / 2) < 0.5 };
        });
        assert.ok(Math.abs(shape.width - shape.height) < 0.5, `${theme} at ${width}px has a square hover area: ${shape.width} x ${shape.height}`);
        assert.equal(shape.radius, '50%');
        assert.notEqual(shape.background, 'rgba(0, 0, 0, 0)');
        assert.equal(shape.centered, true);
        assert.equal(await page.locator('.pb-queue-item.playing .pb-queue-rm').count(), 1);
        if (process.env.QUEUE_ARTIFACT_DIR) {
          await mkdir(process.env.QUEUE_ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: `${process.env.QUEUE_ARTIFACT_DIR}/queue-${theme}-${width}.png` });
        }
      }
    }
  } finally { await page.close(); }
});

test('removing the current track immediately plays its queue successor in every mode', async () => {
  for (const mode of ['sequential', 'single', 'shuffle']) {
    const page = await openQueue(1, mode);
    try {
      await page.locator('.pb-queue-item.playing .pb-queue-rm').click();
      await playingTrack(page, 'c');
      assert.deepEqual(await state(page), { ids: ['a', 'c'], current: 'c', index: 1 });
      assert.equal(await page.locator('.pb-queue-item.playing .pb-queue-title').textContent(), 'c');
      const persisted = await page.evaluate(() => JSON.parse(sessionStorage.getItem('edgesonic:queue')));
      assert.deepEqual(persisted.map(track => track.id), ['a', 'c']);
      assert.equal(await page.evaluate(() => window.queueAudio.some(el => el.currentSrc.endsWith('/b.wav') && !el.paused)), false);
    } finally { await page.close(); }
  }
});

test('removing entries before and after the current track preserves its playback', async () => {
  const page = await openQueue();
  try {
    await page.evaluate(() => {
      const active = window.queueAudio.find(el => !el.paused);
      active.currentTime = 15;
      active.dispatchEvent(new Event('timeupdate'));
    });
    await page.waitForFunction(() => window.queueAudio.some(el => !el.paused && !el.seeking && el.currentTime >= 15));
    await page.getByRole('button', { name: 'Remove a from queue', exact: true }).click();
    assert.deepEqual(await state(page), { ids: ['b', 'c'], current: 'b', index: 0 });
    await page.getByRole('button', { name: 'Remove c from queue', exact: true }).click();
    assert.deepEqual(await state(page), { ids: ['b'], current: 'b', index: 0 });
    await playingTrack(page, 'b');
    assert.ok(await page.evaluate(() => window.queueAudio.find(el => !el.paused).currentTime >= 15));
  } finally { await page.close(); }
});

test('removing the queue tail wraps to the first track, and removing the final track stops audio', async () => {
  const page = await openQueue(2);
  try {
    await page.locator('.pb-queue-item.playing .pb-queue-rm').click();
    await playingTrack(page, 'a');
    assert.deepEqual(await state(page), { ids: ['a', 'b'], current: 'a', index: 0 });
    await page.getByRole('button', { name: 'Remove b from queue', exact: true }).click();
    await page.locator('.pb-queue-item.playing .pb-queue-rm').click();
    assert.deepEqual(await state(page), { ids: [], current: null, index: -1 });
    assert.deepEqual(await page.evaluate(() => ({ playing: window.player.playing, time: window.player.currentTime, duration: window.player.duration, audioStopped: window.queueAudio.every(el => el.paused && !el.getAttribute('src')) })), { playing: false, time: 0, duration: 0, audioStopped: true });
    assert.equal(await page.locator('.pb-queue-empty').isVisible(), true);
  } finally { await page.close(); }
});

test('removing a prepared next track cannot play its stale audio or leave invalid shuffle indices', async () => {
  const page = await openQueue(0);
  try {
    await page.evaluate(() => {
      const active = window.queueAudio.find(el => !el.paused);
      active.currentTime = 55;
      active.dispatchEvent(new Event('timeupdate'));
    });
    await page.waitForFunction(() => window.queueAudio.some(el => el.paused && el.currentSrc.startsWith('blob:') && el.readyState >= 2));
    await page.getByRole('button', { name: 'Remove b from queue', exact: true }).click();
    await page.evaluate(() => window.player.next());
    await playingTrack(page, 'c');
    assert.deepEqual(await state(page), { ids: ['a', 'c'], current: 'c', index: 1 });
    await page.evaluate(() => window.player.cyclePlayMode());
    await page.evaluate(() => window.player.cyclePlayMode());
    await page.getByRole('button', { name: 'Remove a from queue', exact: true }).click();
    for (let step = 0; step < 3; step++) {
      await page.evaluate(() => window.player.next());
      await playingTrack(page, 'c');
      assert.deepEqual(await state(page), { ids: ['c'], current: 'c', index: 0 });
    }
  } finally { await page.close(); }
});
