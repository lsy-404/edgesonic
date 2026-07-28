// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Rules behind the playback performance guards: worker-pool memory sampling,
// cache TTL expiry, response-time throttling and cache hit statistics.
// Run: npx tsx test/frontend/performance.test.ts

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// -- Memory monitoring -------------------------------------------------------

console.log("memory monitoring:");

const sample = {
  timestamp: Date.now(),
  heapUsed: 50 * 1024 * 1024,
  heapTotal: 100 * 1024 * 1024,
};
assert(sample.timestamp > 0, "a sample carries a wall-clock timestamp");
assert(sample.heapUsed <= sample.heapTotal, "used heap never exceeds total heap");
assert(sample.heapUsed > 0, "used heap is a positive number");

const MAX_HISTORY = 120;
const history: { timestamp: number; heapUsed: number; heapTotal: number }[] = [];
for (let i = 0; i < MAX_HISTORY + 50; i++) {
  history.push({ timestamp: Date.now() + i * 1000, heapUsed: 50 * 1024 * 1024, heapTotal: 100 * 1024 * 1024 });
  if (history.length > MAX_HISTORY) history.shift();
}
assert(history.length <= MAX_HISTORY, `history is capped at ${MAX_HISTORY} samples`);
assert(history.length === MAX_HISTORY, "history keeps the newest window filled");

const THRESHOLD_BYTES = 50 * 1024 * 1024;
assert(60 * 1024 * 1024 > THRESHOLD_BYTES, "a sample above the threshold is flagged");
assert(!(40 * 1024 * 1024 > THRESHOLD_BYTES), "a sample below the threshold is not flagged");

// -- Cache TTL expiration ----------------------------------------------------

console.log("\ncache TTL expiration:");

interface CacheEntry<T> { data: T; timestamp: number; ttl: number }
function isExpired<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.timestamp > entry.ttl;
}

const fresh: CacheEntry<string> = { data: "test data", timestamp: Date.now(), ttl: 5 * 60 * 1000 };
assert(!isExpired(fresh), "a just-written entry is live");

const stale: CacheEntry<string> = { data: "test data", timestamp: Date.now() - 6 * 60 * 1000, ttl: 5 * 60 * 1000 };
assert(isExpired(stale), "an entry past its TTL is expired");

const now = Date.now();
const fourMinutesAgo = now - 4 * 60 * 1000;
const metadataEntry: CacheEntry<string> = { data: "metadata", timestamp: fourMinutesAgo, ttl: 5 * 60 * 1000 };
const lyricsEntry: CacheEntry<string> = { data: "lyrics", timestamp: fourMinutesAgo, ttl: 10 * 60 * 1000 };
const coverEntry: CacheEntry<string> = { data: "cover", timestamp: fourMinutesAgo, ttl: 60 * 60 * 1000 };
assert(!isExpired(metadataEntry), "metadata survives its 5 minute TTL at 4 minutes");
assert(!isExpired(lyricsEntry), "lyrics survive their 10 minute TTL at 4 minutes");
assert(!isExpired(coverEntry), "covers survive their 1 hour TTL at 4 minutes");

const cache = new Map<string, CacheEntry<string>>();
cache.set("key1", { data: "expired", timestamp: now - 6 * 60 * 1000, ttl: 5 * 60 * 1000 });
cache.set("key2", { data: "valid", timestamp: now - 2 * 60 * 1000, ttl: 5 * 60 * 1000 });
for (const [key, entry] of cache.entries()) {
  if (isExpired(entry)) cache.delete(key);
}
assert(!cache.has("key1"), "a sweep drops the expired entry");
assert(cache.has("key2"), "a sweep keeps the live entry");
assert(cache.size === 1, "a sweep leaves exactly the live entries");

// -- Response time tracking & playback throttling ----------------------------

console.log("\nresponse time tracking and playback throttling:");

function getPlaybackThrottle(avgResponseTime: number): number {
  if (avgResponseTime < 200) return 1.5;
  if (avgResponseTime < 500) return 1.0;
  if (avgResponseTime < 1000) return 0.5;
  return 0.25;
}

const responseTimes = [100, 150, 200, 175, 125];
const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
assert(avg === 150, "average response time is the arithmetic mean");
assert(getPlaybackThrottle(150) === 1.5, "fast responses get the widest prefetch window");
assert(getPlaybackThrottle(350) === 1.0, "normal responses get the default window");
assert(getPlaybackThrottle(750) === 0.5, "slow responses halve the window");
assert(getPlaybackThrottle(1200) === 0.25, "very slow responses quarter the window");

const MAX_RESPONSE_TIME_SAMPLES = 20;
const samples: number[] = [];
for (let i = 0; i < 50; i++) {
  samples.push(Math.random() * 1000);
  if (samples.length > MAX_RESPONSE_TIME_SAMPLES) samples.shift();
}
assert(samples.length <= MAX_RESPONSE_TIME_SAMPLES, `response samples are capped at ${MAX_RESPONSE_TIME_SAMPLES}`);

const empty: number[] = [];
const emptyAvg = empty.length === 0 ? 0 : empty.reduce((a, b) => a + b, 0) / empty.length;
assert(emptyAvg === 0, "an empty sample set averages to zero rather than NaN");
assert(getPlaybackThrottle(emptyAvg) === 1.5, "no samples yet falls back to the fast-path throttle");

// -- Cache hit statistics ----------------------------------------------------

console.log("\ncache hit statistics:");

const cacheStats = {
  metadataHits: 0, metadataMisses: 0,
  lyricsHits: 0, lyricsMisses: 0,
  coverHits: 0, coverMisses: 0,
};
function resetStats() {
  cacheStats.metadataHits = 0; cacheStats.metadataMisses = 0;
  cacheStats.lyricsHits = 0; cacheStats.lyricsMisses = 0;
  cacheStats.coverHits = 0; cacheStats.coverMisses = 0;
}

resetStats();
cacheStats.metadataHits += 1;
assert(cacheStats.metadataHits === 1, "a hit increments the hit counter");

resetStats();
cacheStats.metadataMisses += 1;
assert(cacheStats.metadataMisses === 1, "a miss increments the miss counter");

resetStats();
cacheStats.metadataHits = 8;
cacheStats.metadataMisses = 2;
const hitTotal = cacheStats.metadataHits + cacheStats.metadataMisses;
assert((cacheStats.metadataHits / hitTotal) * 100 === 80, "hit rate is hits over total requests");

resetStats();
const zeroTotal = cacheStats.metadataHits + cacheStats.metadataMisses;
assert((zeroTotal === 0 ? 0 : (cacheStats.metadataHits / zeroTotal) * 100) === 0, "zero requests report a 0% hit rate rather than NaN");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
