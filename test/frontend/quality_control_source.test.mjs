import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [qualityControl, choiceFlyout] = await Promise.all([
  readFile(new URL("../../web/src/components/PlayerQualityControl.vue", import.meta.url), "utf8"),
  readFile(new URL("../../web/src/components/WinChoiceFlyout.vue", import.meta.url), "utf8"),
]);

assert.match(qualityControl, /usePlayerStore/);
assert.match(qualityControl, /v-model="player\.playbackQuality"/);
assert.match(qualityControl, /new Audio\(\)\.canPlayType/);
assert.match(qualityControl, /"opus-128"/);
assert.match(choiceFlyout, /<Teleport to="body">/);
assert.match(choiceFlyout, /placeFloatingMenu/);
assert.match(choiceFlyout, /role="listbox"/);
assert.match(choiceFlyout, /aria-selected/);
assert.match(choiceFlyout, /event\.key === "ArrowDown"/);
assert.match(choiceFlyout, /event\.key === "Escape"/);
assert.match(choiceFlyout, /document\.addEventListener\("pointerdown"/);
assert.match(choiceFlyout, /closeMenu\(true\)/);
console.log("quality control source contract passed");
