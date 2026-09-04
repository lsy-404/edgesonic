class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FakeAudio extends EventTarget {
  bufferedSeconds = 0;
  networkState = 2;
  readyState = 2;
  paused = false;
  error: MediaError | null = null;
  get buffered() {
    const seconds = this.bufferedSeconds;
    return { length: seconds > 0 ? 1 : 0, start: () => 0, end: () => seconds } as TimeRanges;
  }
}

async function main() {
const storage = new MemoryStorage();
const fakeWindow = new EventTarget();
Object.assign(globalThis, {
  window: fakeWindow,
  localStorage: storage,
  sessionStorage: storage,
  location: new URL("https://player.example/"),
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: undefined } });
const oldSetInterval = globalThis.setInterval;
globalThis.setInterval = (() => 0) as typeof setInterval;

const { beginAudioRequest, beginRequest, endAudioRequest, initNetDiag } = await import("../../web/src/lib/netDiag.ts");
initNetDiag();
globalThis.setInterval = oldSetInterval;

let failures = 0;
function assert(condition: unknown, label: string) {
  if (condition) console.log(`  PASS ${label}`);
  else { failures++; console.error(`  FAIL ${label}`); }
}
function inflight(): Array<{ bytes: number; audio?: { bufferedSeconds: number } }> {
  return (fakeWindow as unknown as { __esNetDiag: { inflight(): Array<{ bytes: number; audio?: { bufferedSeconds: number } }> } }).__esNetDiag.inflight();
}

const audio = new FakeAudio() as unknown as HTMLAudioElement;
beginAudioRequest(audio, "audio-stream", "https://cdn.example/file?token=secret");
audio.dispatchEvent(new Event("emptied"));
assert(inflight().length === 0, "initial emptied event does not finish an unstarted audio request");
audio.dispatchEvent(new Event("loadstart"));
assert(inflight().length === 1, "loadstart begins native audio observation");
audio.bufferedSeconds = 3;
audio.dispatchEvent(new Event("progress"));
audio.dispatchEvent(new Event("suspend"));
audio.bufferedSeconds = 7;
audio.dispatchEvent(new Event("progress"));
assert(inflight()[0]?.audio?.bufferedSeconds === 7 && inflight()[0]?.bytes === 0, "suspend followed by progress remains observable without inventing bytes");
endAudioRequest(audio);
assert(inflight().length === 0, "explicit source end cleans up the audio request");
audio.bufferedSeconds = 9;
audio.dispatchEvent(new Event("progress"));
assert(inflight().length === 0, "cleaned listeners do not recreate a completed request");

const generic = beginRequest("api", "/rest/ping?token=secret");
generic.end();
generic.fail(new Error("second terminal call"));
assert(inflight().length === 0, "generic terminal methods are idempotent");

const pending = beginRequest("api", "/rest/ping?token=secret");
pending.headers(200);
fakeWindow.dispatchEvent(new Event("pagehide"));
const snapshot = storage.getItem("edgesonic:netdiag:last-pagehide") || "";
assert(snapshot.includes("/rest/ping") && !snapshot.includes("secret"), "pagehide stores a sanitized bounded snapshot");
assert(JSON.parse(snapshot)[0]?.phase === "body" && JSON.parse(snapshot)[0]?.status === 200,
  "a stalled response body is distinguishable from waiting for headers");
pending.end();
fakeWindow.dispatchEvent(new Event("pagehide"));
assert(storage.getItem("edgesonic:netdiag:last-pagehide") === null, "empty pagehide clears an obsolete snapshot");

if (failures) process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
