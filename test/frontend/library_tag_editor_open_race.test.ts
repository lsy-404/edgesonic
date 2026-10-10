import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRequestEpoch } from "../../web/src/lib/requestEpoch";

const ROOT = join(__dirname, "..", "..");
const LIBRARY = readFileSync(join(ROOT, "web", "src", "views", "Library.vue"), "utf8");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a slow getSong response cannot replace the newer selected song", async () => {
  const requests = createRequestEpoch();
  const first = deferred<string>();
  const second = deferred<string>();
  const opened: string[] = [];

  const firstEpoch = requests.begin();
  const firstOpen = first.promise.then((song) => {
    if (requests.isCurrent(firstEpoch)) opened.push(song);
  });
  const secondEpoch = requests.begin();
  const secondOpen = second.promise.then((song) => {
    if (requests.isCurrent(secondEpoch)) opened.push(song);
  });

  second.resolve("song-b: complete metadata");
  await secondOpen;
  first.resolve("song-a: stale metadata");
  await firstOpen;

  assert.deepEqual(opened, ["song-b: complete metadata"]);
});

test("closing while getSong is pending prevents the late response from opening", async () => {
  const requests = createRequestEpoch();
  const pending = deferred<string>();
  const opened: string[] = [];
  const epoch = requests.begin();
  const open = pending.promise.then((song) => {
    if (requests.isCurrent(epoch)) opened.push(song);
  });

  requests.invalidate();
  pending.resolve("closed song");
  await open;

  assert.deepEqual(opened, []);
});

test("Library opens only after getSong and invalidates pending single requests on switch or close", () => {
  const openEditor = LIBRARY.match(/async function openEditor\(s: Track\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(openEditor, "single editor opener exists");
  assert.ok(openEditor.indexOf("await authFetch(\"getSong\"") < openEditor.indexOf("editorOpen.value = true"), "editor waits for getSong before opening");
  assert.ok(openEditor.indexOf("editorRequestEpoch.isCurrent(requestEpoch)") < openEditor.indexOf("editorOpen.value = true"), "stale requests return before opening");
  assert.match(LIBRARY, /function openBatchEditor\(\) \{[\s\S]*?editorRequestEpoch\.invalidate\(\)/, "switching to batch invalidates a pending single request");
  assert.match(LIBRARY, /function closeEditor\(\) \{\s*editorRequestEpoch\.invalidate\(\)/, "closing invalidates a pending single request");
});
