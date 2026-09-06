import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
assert.match(host, /aria-modal="true"/);
console.log("detail panel source contract passed");
