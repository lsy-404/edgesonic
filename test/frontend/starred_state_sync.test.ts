class StorageMock {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const local = new StorageMock();
local.setItem("edgesonic_logged_in", "1");
local.setItem("edgesonic_user", "alice");
const session = new StorageMock();
Object.defineProperties(globalThis, {
  localStorage: { configurable: true, value: local },
  sessionStorage: { configurable: true, value: session },
  window: { configurable: true, value: { addEventListener() {}, removeEventListener() {} } },
  document: { configurable: true, value: { hidden: false, createElement() { return {}; }, documentElement: { setAttribute() {} } } },
  location: { configurable: true, value: { href: "http://test/" } },
});

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
  const timer = originalSetInterval(handler, timeout, ...args);
  (timer as any).unref?.();
  return timer;
}) as typeof setInterval;

let resolveStaleSong: ((response: Response) => void) | undefined;
let staleSongRequested = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/rest/getSong")) {
    staleSongRequested = true;
    return new Promise<Response>((resolve) => { resolveStaleSong = resolve; });
  }
  if (url.includes("/rest/star")) return new Response('<subsonic-response status="ok"/>');
  throw new Error(`Unexpected request: ${url}`);
}) as typeof fetch;

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

async function run() {
  const { nextTick } = await import("vue");
  const { createPinia, setActivePinia } = await import("pinia");
  const { usePlayerStore } = await import("../../web/src/stores/player");
  setActivePinia(createPinia());
  const player = usePlayerStore();
  player.$patch({ queue: [{ id: "song-1", title: "Song", artist: "Artist", album: "Album", duration: 0 }], index: 0 });
  await nextTick();
  await Promise.resolve();
  assert(staleSongRequested && resolveStaleSong, "current track starts a metadata request");

  player.setStarred("song-1", true);
  resolveStaleSong!(new Response('<subsonic-response><song id="song-1" /></subsonic-response>'));
  await Promise.resolve();
  await nextTick();
  assert(player.starred === true, "late unstarred metadata cannot overwrite a newer public update");
  assert(player.queue[0]?.starred === true, "newer public update remains on the queued track");

  player.setStarred("song-1", false);
  await player.toggleStar();
  assert(player.starred === true, "successful player toggle keeps the optimistic starred state");
  assert(player.queue[0]?.starred === true, "successful player toggle keeps queue state aligned");

  clearInterval((globalThis as any).__trackPrefetchCleanupInterval);
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
