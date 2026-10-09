// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createPinia } from "pinia";

class Storage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  private source = "";
  currentSrc = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 30;
  paused = true;
  ended = false;
  networkState = 2;
  readyState = 3;
  error: { code: number; message: string } | null = null;
  get buffered() { return { length: 0, start: () => 0, end: () => 0 } as TimeRanges; }
  get src() { return this.source; }
  set src(value: string) {
    this.source = value;
    this.currentSrc = value;
    this.currentTime = 0;
    this.ended = false;
    this.error = null;
  }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  constructor() { super(); FakeAudio.instances.push(this); }
  load() {
    queueMicrotask(() => {
      this.dispatchEvent(new Event("loadedmetadata"));
      this.dispatchEvent(new Event("canplay"));
    });
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.dispatchEvent(new Event("pause")));
  }
  async play() {
    this.paused = false;
    this.ended = false;
    queueMicrotask(() => this.dispatchEvent(new Event("play")));
  }
  finish(at: number, reportedEnd = at) {
    this.currentTime = at;
    this.dispatchEvent(new Event("timeupdate"));
    this.currentTime = reportedEnd;
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event("timeupdate"));
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }
}

test("incremental audio recovery lifecycle", { timeout: 15_000 }, async (t) => {
  const storage = new Storage();
  storage.setItem("edgesonic:playMode", "sequential");
  const blobs = new Map<string, Blob>();
  let blobId = 0;
  Object.assign(globalThis, {
    window: new EventTarget(), document: { hidden: false },
    localStorage: storage, sessionStorage: storage, Audio: FakeAudio,
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaSession: undefined } });
  t.mock.method(URL, "createObjectURL", (blob: Blob) => {
    const url = "blob:recovered-" + ++blobId;
    blobs.set(url, blob);
    return url;
  });
  t.mock.method(URL, "revokeObjectURL", (url: string) => { blobs.delete(url); });
  const setInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => setInterval(...args).unref());

  const totalBytes = 2_600_000;
  const requests: Array<{ path: string; start: number; end: number; closed: boolean }> = [];
  let hold = false;
  let release: (() => void) | undefined;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    const size = path === "/exact" ? 2_400_000 : totalBytes;
    const start = Number(match?.[1] ?? 0);
    const end = Math.min(Number(match?.[2] ?? size - 1), size - 1);
    const record = { path, start, end, closed: false };
    requests.push(record);
    response.on("close", () => { record.closed = true; });
    if (start >= size) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    const ranged = !!match && path !== "/whole";
    const body = Buffer.alloc(ranged ? end - start + 1 : size);
    response.writeHead(ranged ? 206 : 200, {
      "Content-Type": "audio/mpeg", "Content-Length": body.length,
      ...(ranged ? { "Content-Range": "bytes " + start + "-" + end + "/" + size } : {}),
    });
    if (hold && path === "/held") {
      response.write(body.subarray(0, 1024));
      release = () => response.end(body.subarray(1024));
    } else response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const origin = "http://127.0.0.1:" + address.port;
  const { usePlayerStore } = await import("../../web/src/stores/player.ts");
  const player = usePlayerStore(createPinia());
  t.after(async () => {
    player.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const wait = (condition: () => boolean) => t.waitFor(() => assert.ok(condition()), { interval: 5, timeout: 2_000 });
  const track = (id: string, path: string) => ({ id, title: "Track", artist: "Artist", album: "Album", duration: 30, streamUrl: origin + path });
  async function recover(path: string) {
    player.setQueue([track("recover", path), track("next", "/next")]);
    await wait(() => FakeAudio.instances.some((item) => item.src === origin + path));
    const audio = FakeAudio.instances.find((item) => item.src === origin + path)!;
    await wait(() => !audio.paused);
    audio.error = { code: 3, message: "decode" };
    audio.dispatchEvent(new Event("error"));
    await wait(() => audio.src.startsWith("blob:") && !audio.paused);
    return audio;
  }

  await t.test("partial pause/ended continues the same track and only complete audio advances", async () => {
    const audio = await recover("/segments");
    const first = requests.filter((r) => r.path === "/segments")[0];
    audio.finish(3, audio.duration);
    assert.equal(player.current?.id, "recover");
    await wait(() => requests.filter((r) => r.path === "/segments").length === 2 && !audio.paused);
    assert.equal(audio.currentTime, 3);
    assert.equal(requests.filter((r) => r.path === "/segments")[1].start, first.end + 1);
    audio.finish(11, audio.duration);
    await wait(() => blobs.get(audio.src)?.size === totalBytes && !audio.paused);
    assert.equal(player.current?.id, "recover");
    assert.equal(audio.currentTime, 11);
    audio.finish(30);
    assert.equal(player.current?.id, "next");
  });

  await t.test("partial decode errors continue from the last downloaded byte", async () => {
    const audio = await recover("/decode");
    const first = requests.filter((r) => r.path === "/decode")[0];
    audio.currentTime = 3;
    audio.error = { code: 3, message: "incomplete data" };
    audio.dispatchEvent(new Event("error"));
    await wait(() => requests.filter((r) => r.path === "/decode").length === 2 && audio.currentTime === 3);
    assert.equal(player.current?.id, "recover");
    assert.equal(requests.filter((r) => r.path === "/decode")[1].start, first.end + 1);
  });

  await t.test("a full response to a Range request finishes without another download", async () => {
    const audio = await recover("/whole");
    assert.equal(blobs.get(audio.src)?.size, totalBytes);
    audio.finish(30);
    assert.equal(player.current?.id, "next");
    assert.equal(requests.filter((r) => r.path === "/whole").length, 1);
  });

  await t.test("a terminal full-sized Range uses the declared total to finish", async () => {
    const audio = await recover("/exact");
    audio.finish(3, audio.duration);
    await wait(() => blobs.get(audio.src)?.size === 2_400_000 && !audio.paused);
    audio.finish(30);
    assert.equal(player.current?.id, "next");
    assert.equal(requests.filter((r) => r.path === "/exact").length, 2);
  });

  await t.test("user pause cancels an unfinished continuation and resume retains the position", async () => {
    const audio = await recover("/held");
    hold = true;
    release = undefined;
    audio.finish(3);
    await wait(() => !!release);
    player.toggle();
    await wait(() => requests.filter((r) => r.path === "/held").at(-1)!.closed);
    assert.equal(player.playing, false);
    assert.equal(player.current?.id, "recover");
    hold = false;
    player.toggle();
    await wait(() => !audio.paused && audio.currentTime === 3);
    assert.equal(player.current?.id, "recover");
  });

  await t.test("changing tracks cancels pending continuation without restoring the previous track", async () => {
    hold = false;
    release = undefined;
    const audio = await recover("/held");
    hold = true;
    audio.finish(3);
    await wait(() => !!release);
    const pending = requests.filter((r) => r.path === "/held").at(-1)!;
    player.playAt(1);
    await wait(() => pending.closed);
    assert.equal(player.current?.id, "next");
    await wait(() => audio.src === origin + "/next");
    hold = false;
  });

  await t.test("ordinary native completion still advances the queue", async () => {
    player.setQueue([track("native", "/native"), track("next", "/next")]);
    await wait(() => FakeAudio.instances.some((item) => item.src === origin + "/native"));
    const audio = FakeAudio.instances.find((item) => item.src === origin + "/native")!;
    await wait(() => !audio.paused);
    audio.finish(30);
    assert.equal(player.current?.id, "next");
  });
});
