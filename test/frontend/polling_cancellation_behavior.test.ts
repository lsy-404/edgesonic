// Runtime behavior test for the Podcasts polling lifecycle.
// The script setup is compiled from the real component and executed with
// browser/auth/timer dependencies mocked at the boundary.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";

const root = join(__dirname, "../..");
const source = readFileSync(join(root, "web/src/views/Podcasts.vue"), "utf8");
const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("Podcasts script setup not found");

const transformed = transformSync(
  script.replace(/^import[^\n]+\n/gm, "") +
    "\nglobalThis.__probe = { mountedHook, unmountedHook, visibilityHook: globalThis.visibilityHook };\n",
  { loader: "ts", format: "iife", target: "es2020" },
).code;

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

type Deferred = { promise: Promise<string>; resolve: (value: string) => void; signal?: AbortSignal };
const requests: Deferred[] = [];
function authFetch(_path: string, _params?: unknown, signal?: AbortSignal): Promise<string> {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  const request = { promise, resolve, signal };
  requests.push(request);
  return promise;
}

let nextTimer = 1;
const timers = new Map<number, () => void>();
const documentListeners = new Map<string, () => void>();
const documentMock = {
  hidden: false,
  addEventListener(type: string, listener: () => void) {
    documentListeners.set(type, listener);
    if (type === "visibilitychange") (context as any).visibilityHook = listener;
  },
  removeEventListener(type: string) { documentListeners.delete(type); },
};
const windowMock = {
  setTimeout(callback: () => void) { const id = nextTimer++; timers.set(id, callback); return id; },
  clearTimeout(id: number) { timers.delete(id); },
};

const context = vm.createContext({
  AbortController,
  DOMException,
  JSON,
  Map,
  Set,
  Date,
  Math,
  Promise,
  console,
  setTimeout: windowMock.setTimeout,
  clearTimeout: windowMock.clearTimeout,
  window: windowMock,
  document: documentMock,
  ref: (value: unknown) => ({ value }),
  computed: (getter: () => unknown) => ({ get value() { return getter(); } }),
  onMounted: (callback: () => Promise<void>) => { (context as any).mountedHook = callback; },
  onUnmounted: (callback: () => void) => { (context as any).unmountedHook = callback; },
  useI18n: () => ({ t: (key: string) => key }),
  useAuth: () => ({ isAdmin: { value: true }, authFetch, coverArtUrl: () => "" }),
  parseXmlAttrs: () => [],
  formatDuration: () => "",
});
vm.runInContext(transformed, context);
const probe = (context as any).__probe as {
  mountedHook: () => Promise<void>;
  unmountedHook: () => void;
  visibilityHook?: () => void;
};

async function main(): Promise<void> {
  const okXml = '<subsonic-response status="ok"><podcastChannels /></subsonic-response>';
  const mounted = probe.mountedHook();
  assert(requests.length === 1, "mount starts exactly one initial request");
  requests[0].resolve(okXml);
  await mounted;
  probe.visibilityHook = (context as any).visibilityHook;
  assert(timers.size === 1, "initial completion schedules one poll timer");

  const firstPollTimer = timers.values().next().value as () => void;
  timers.clear();
  firstPollTimer();
  assert(requests.length === 2, "first timer starts one poll request");
  assert(timers.size === 0, "a pending poll does not schedule an overlapping timer");

  documentMock.hidden = true;
  probe.visibilityHook?.();
  assert(requests[1].signal?.aborted === true, "hiding the page aborts the active poll request");
  documentMock.hidden = false;
  probe.visibilityHook?.();
  assert(requests.length === 3, "quick visibility recovery starts a fresh request");

  requests[1].resolve(okXml);
  await Promise.resolve();
  assert(requests.length === 3, "the old aborted request cannot create a competing recovery request");

  probe.unmountedHook();
  assert(requests[2].signal?.aborted === true, "unmount aborts the current request");
  assert(timers.size === 0, "unmount clears all scheduled polling timers");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

void main();
