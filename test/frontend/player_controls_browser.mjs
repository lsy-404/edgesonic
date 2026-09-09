import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
const browser = await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || 'msedge'});
try {
 const page = await browser.newPage({viewport:{width:1440,height:900}});
 const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 const fixture = fileURLToPath(new URL('./player_controls_browser.html',import.meta.url));
 await page.goto(`${process.env.WEB_BASE_URL || 'http://127.0.0.1:5187'}/@fs${fixture}`);
 await page.waitForFunction(() => !!window.setTheme);
 const playMode = page.locator('.pb-mode');
 const restingModeBox = await playMode.boundingBox();
 await playMode.hover();
 await page.mouse.down();
 const pressedModeBox = await playMode.boundingBox();
 assert.ok(Math.abs((pressedModeBox.y - restingModeBox.y) - 1) < 0.5, 'play-mode press keeps its centered position and moves only one pixel');
 await page.mouse.up();
 assert.equal(await page.evaluate(() => window.player.playMode), 'single', 'one click advances sequential mode to repeat-one');
 await playMode.click();
 assert.equal(await page.evaluate(() => window.player.playMode), 'shuffle', 'the next click advances repeat-one to shuffle');
 await playMode.click();
 assert.equal(await page.evaluate(() => window.player.playMode), 'sequential', 'the next click advances shuffle to sequential');
 for (const theme of ['sp-ark','sp-earth','sp-gold','sp-ocean','sp-scarlet','sp-sky','sp-crimson','sp-end','black','white','sp-ark']) {
  await page.evaluate(async t => await window.setTheme(t),theme);
  await page.waitForTimeout(180);
  const state = await page.locator('.pb-progress-thumb').evaluate(el => ({custom:el.classList.contains('pb-progress-thumb-custom'),visible:el.querySelector('.thumb-crystal')?getComputedStyle(el.querySelector('.thumb-crystal')).display:null,after:getComputedStyle(el,'::after').content,width:el.querySelector('canvas')?.getBoundingClientRect().width}));
  assert.equal(state.custom,theme.startsWith('sp-'));
  if(state.custom) {assert.equal(state.visible,'block');assert.equal(state.width,44);assert.equal(state.after,'none');}
  else assert.equal(state.after,'""');
  for(const selected of [false,true,false]) {
   await page.evaluate(v=>window.setStarred(v),selected);
   await page.locator('.star-button').hover();
   await page.waitForTimeout(200);
   const star = await page.locator('.star-button').evaluate(el=>({color:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor,fill:getComputedStyle(el.querySelector('svg')).fill,accent:getComputedStyle(el).getPropertyValue('--color-accent-primary').trim(),pressed:el.getAttribute('aria-pressed')}));
   assert.equal(star.pressed,String(selected));
   assert.equal(star.fill==='none',!selected);
   assert.notEqual(star.color,star.bg);
  }
  await page.locator('.list-options-btn').click();
  const control = page.locator('.list-options-menu [role="switch"]');
  for (const selected of [false,true,false]) {
   if (await control.getAttribute('aria-checked') !== String(selected)) await control.click();
   await page.waitForTimeout(200);
   assert.equal(await control.getAttribute('aria-checked'),String(selected));
   const colors=await control.evaluate(el=>({track:getComputedStyle(el.querySelector('.fluent-switch__track')).backgroundColor,thumb:getComputedStyle(el.querySelector('.fluent-switch__thumb')).backgroundColor}));
   assert.notEqual(colors.track,'rgba(0, 0, 0, 0)');
   assert.notEqual(colors.thumb,'rgba(0, 0, 0, 0)');
   assert.notEqual(colors.track,colors.thumb);
  }
  await page.locator('.list-options-text').click();
  assert.equal(await control.getAttribute('aria-checked'),'true');
  await control.focus();
  await control.press('Space');
  assert.equal(await control.getAttribute('aria-checked'),'false');
  await page.locator('.list-options-btn').click();
  console.log(`${theme}: marker, favorite, and instrumental toggle states passed`);
 }
 const progress = await page.locator('.pb-progress').boundingBox();
 await page.mouse.move(progress.x+progress.width*0.75,progress.y+progress.height/2);
 await page.mouse.down();
 assert.equal(await page.locator('.pb-progress-thumb.active').count(),1);
 assert.equal(await page.locator('.pb-progress-tooltip').count(),1);
 await page.mouse.up();
 assert.equal(await page.locator('.pb-progress-thumb.active').count(),0);
 const slider = page.locator('.player-volume__desktop-slider input');
 assert.equal(await page.locator('.player-volume__percent').count(),0);
 await slider.focus();
 await slider.press('End');
 await page.waitForTimeout(150);
 const percent = page.locator('.player-volume__percent');
 assert.equal(await percent.textContent(),'100%');
 const rangeBox = await slider.boundingBox();
 const percentBox = await percent.boundingBox();
 const qualityBox = await page.locator('.pb-quality-wrap').boundingBox();
 assert.ok(percentBox.x >= rangeBox.x+rangeBox.width);
 assert.ok(percentBox.x+percentBox.width <= qualityBox.x);
 assert.ok(Math.abs(percentBox.y+percentBox.height/2-qualityBox.y-qualityBox.height/2)<5);
 await slider.click();
 assert.equal(await percent.count(),1);
 await slider.evaluate(el=>el.blur());
 assert.equal(await percent.count(),0);
 await slider.hover();
 assert.equal(await percent.count(),0);
 for (const width of [1024,1440]) {
  await page.setViewportSize({width,height:900});
  await slider.focus();
  const range = await slider.boundingBox();
  const readout = await percent.boundingBox();
  const quality = await page.locator('.pb-quality-wrap').boundingBox();
  const audio = await page.locator('.player-volume').boundingBox();
  const progress = await page.locator('.pb-progress').boundingBox();
  assert.ok(readout.x >= range.x+range.width);
  assert.ok(readout.x+readout.width <= quality.x);
  assert.ok(audio.x >= progress.x+progress.width);
  await slider.evaluate(el=>el.blur());
 }
 await page.setViewportSize({width:390,height:844});
 await page.locator('.player-volume__button').click();
 const mobileSlider = page.locator('.player-volume__popup input');
 await mobileSlider.press('End');
 const mobileReadout = await page.locator('.player-volume__popup .player-volume__percent').boundingBox();
 const mobileRange = await mobileSlider.boundingBox();
 assert.ok(mobileReadout.x >= mobileRange.x+mobileRange.width);
 assert.ok(Math.abs(mobileReadout.y+mobileReadout.height/2-mobileRange.y-mobileRange.height/2)<3);
 const tokens = await mobileSlider.evaluate(el => ['--fluent-accent','--fluent-border','--fluent-accent-text','--fluent-slider-position'].map(name=>getComputedStyle(el).getPropertyValue(name).trim()));
 assert.ok(tokens.every(Boolean));
 await page.screenshot({path:fileURLToPath(new URL('../artifacts/player-controls-mobile.png',import.meta.url))});
 await mobileSlider.press('Escape');
 assert.equal(await page.locator('.player-volume__popup').count(),0);
 await page.setViewportSize({width:1440,height:900});
 await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
 await page.screenshot({path:fileURLToPath(new URL('../artifacts/player-controls.png',import.meta.url))});
 assert.deepEqual(errors,[]);
 console.log('Volume focus, right-side percentage, spacing, and idle state passed');
} finally { await browser.close(); }
