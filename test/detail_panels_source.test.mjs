import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const store = read("web/src/stores/detail.ts");
const player = read("web/src/components/PlayerBar.vue");
const host = read("web/src/components/DetailHost.vue");

assert.match(store, /openNowPlaying/);
assert.match(store, /openAlbum/);
assert.match(store, /openArtist/);
assert.match(store, /toggleNowPlaying/);
assert.doesNotMatch(player, /useRouter|useRoute/);
assert.match(player, /var\(--bottom-nav-space/);
assert.match(host, /translateY\(100%\)/);
assert.match(host, /<Library[\s\S]*embedded/);

const behavior = spawnSync(process.execPath, ["--experimental-strip-types", "-e", `
  import { createPinia, setActivePinia } from "pinia";
  import { useDetailStore } from "./web/src/stores/detail.ts";
  import assert from "node:assert/strict";
  setActivePinia(createPinia());
  const detail = useDetailStore();
  assert.equal(detail.isOpen, false);
  detail.openAlbum("album-1");
  assert.deepEqual([detail.kind, detail.target, detail.isOpen], ["album", "album-1", true]);
  detail.openArtist("artist-1");
  assert.deepEqual([detail.kind, detail.target], ["artist", "artist-1"]);
  detail.openNowPlaying();
  assert.deepEqual([detail.kind, detail.target], ["now-playing", null]);
  detail.toggleNowPlaying();
  assert.deepEqual([detail.kind, detail.target, detail.isOpen], ["none", null, false]);
`], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
assert.equal(behavior.status, 0, behavior.stderr);
console.log("detail panel state behavior passed");
