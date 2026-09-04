import * as http from "node:http";
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
  set src(value: string) { this.source = value; this.currentSrc = value; }
  removeAttribute(name: string) { if (name === "src") { this.source = ""; this.currentSrc = ""; } }
  constructor() { super(); FakeAudio.instances.push(this); }
  load() { setTimeout(() => { this.dispatchEvent(new Event("emptied")); this.dispatchEvent(new Event("loadstart")); }, 0); }
  pause() { if (this.paused) return; this.paused = true; setTimeout(() => this.dispatchEvent(new Event("pause")), 0); }
  async play() { this.paused = false; queueMicrotask(() => this.dispatchEvent(new Event("play"))); }
}

async function main() {
const storage = new Storage();
const fakeWindow = new EventTarget();
Object.assign(globalThis, {
  window: fakeWindow,
  document: { hidden: false },
  localStorage: storage,
  sessionStorage: storage,
  Audio: FakeAudio,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaSession: undefined } });
Object.assign(URL, { createObjectURL: () => "blob:recovered", revokeObjectURL: () => {} });

let rangeRequests = 0;
const server = http.createServer((request, response) => {
  if (request.headers.range) rangeRequests++;
  response.writeHead(206, { "Content-Type": "audio/mpeg", "Content-Range": "bytes 0-1199999/2400000" });
  if (rangeRequests === 3) {
    response.write(Buffer.alloc(1024));
    setTimeout(() => { if (!response.destroyed) response.end(Buffer.alloc(1_198_976)); }, 100);
  } else response.end(Buffer.alloc(1_200_000));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind");
const streamUrl = `http://127.0.0.1:${address.port}/stream`;

const { usePlayerStore } = await import("../../web/src/stores/player.ts");
const player = usePlayerStore(createPinia());
let failures = 0;
function assert(condition: unknown, label: string) {
  if (condition) console.log(`  PASS ${label}`);
  else { failures++; console.error(`  FAIL ${label}`); }
}
async function settle() { await new Promise((resolve) => setTimeout(resolve, 30)); }

player.setQueue([{ id: "track", title: "Track", artist: "Artist", album: "Album", duration: 30, streamUrl }]);
const audio = FakeAudio.instances[0];
audio.error = { code: 2, message: "network" };
audio.dispatchEvent(new Event("error"));
await settle();
assert(rangeRequests === 1 && audio.src === "blob:recovered", "first Range recovery completes and replaces the failed native source");

audio.error = { code: 3, message: "decode" };
audio.dispatchEvent(new Event("error"));
await settle();
assert(rangeRequests === 2 && audio.src === "blob:recovered", "internal Blob source change does not cancel the next Range recovery");

audio.error = { code: 3, message: "decode while loading" };
audio.dispatchEvent(new Event("error"));
await new Promise((resolve) => setTimeout(resolve, 10));
assert(rangeRequests === 3, "third Range request starts before the user pauses");
audio.pause();
await settle();
player.toggle();
await new Promise((resolve) => setTimeout(resolve, 140));
assert(audio.paused === false && rangeRequests >= 4 && audio.src === "blob:recovered", "resume rebuilds a cancelled controller and continues the missing Range data");

await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
process.exit(failures ? 1 : 0);
}

void main().catch((error) => { console.error(error); process.exit(1); });
