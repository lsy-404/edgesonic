import assert from "node:assert/strict";
import { ListeningProgress } from "../../web/src/lib/listeningProgress";

const progress = new ListeningProgress();
const update = (currentTime: number, options: { playing?: boolean; duration?: number } = {}) =>
  progress.update({ currentTime, duration: options.duration ?? 2, playing: options.playing ?? true });

assert.equal(update(0), false, "the first timeupdate only establishes a baseline");
assert.equal(update(0.4), false, "partial listening does not submit");
assert.equal(update(0.4, { playing: false }), false, "paused time does not accrue");
assert.equal(update(0.4), false, "resume does not count the paused interval");
assert.equal(update(0.8), false, "resumed playback accumulates real media progress");
assert.equal(update(1.2), true, "half of a short track reaches its listening threshold");
assert.equal(update(1.6), false, "one playback round submits only once");

progress.reset();
update(0);
assert.equal(update(8), false, "a forward seek is not counted as listening");
assert.equal(update(8.4), false, "playback after seeking starts a fresh progress segment");
assert.equal(update(8.8), false, "skipping near the end cannot satisfy the threshold");

progress.reset();
update(0);
progress.anchor(0.4);
assert.equal(update(0.8), false, "a short seek is excluded by resetting the time anchor");
assert.equal(update(1.2), false, "only post-seek playback time accumulates");
assert.equal(update(1.6), true, "continuous playback after a seek can still qualify");

progress.reset();
update(0);
assert.equal(update(0, { playing: false }), false, "preloaded or failed audio makes no progress");
assert.equal(update(0.4), false, "first active tick after start establishes a baseline");
assert.equal(update(0.8), false, "short track has not yet reached half duration");
assert.equal(update(1.2), true, "a naturally progressing two-second track can qualify");

progress.reset();
update(0);
for (let time = 4; time <= 240; time += 4) {
  const shouldReport = update(time, { duration: 600 });
  if (time < 240) assert.equal(shouldReport, false);
  else assert.equal(shouldReport, true, "long tracks use a four-minute cap");
}

progress.reset();
update(0);
assert.equal(update(0.6), false, "a fresh repeat round starts from zero accumulated time");
assert.equal(update(1.2), true, "a fresh repeat can independently qualify");

console.log("player listening progress behavior passed");
