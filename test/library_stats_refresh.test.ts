import assert from "node:assert/strict";
import test from "node:test";
import {
  canRebuildLibraryStats,
  LIBRARY_STATS_REFRESH_ATTEMPTS,
  LIBRARY_STATS_REFRESH_DELAY_MS,
  refreshLibraryStatsWhileStale,
  type LibraryStatsResponse,
} from "../web/src/lib/libraryStats";

function snapshot(overrides: Partial<LibraryStatsResponse> = {}): LibraryStatsResponse {
  return { ok: true, artists: 3, albums: 4, songs: 5, updatedAt: 123, stale: false, ready: true, ...overrides };
}

test("cached counts remain refreshable until a fresh snapshot arrives", async () => {
  const seen: LibraryStatsResponse[] = [];
  const delays: number[] = [];
  let reads = 0;
  await refreshLibraryStatsWhileStale(
    async () => ++reads === 1 ? snapshot({ stale: true, songs: 80 }) : snapshot({ songs: 81 }),
    (value) => seen.push(value),
    () => true,
    async (ms) => { delays.push(ms); },
  );
  assert.equal(reads, 2);
  assert.deepEqual(delays, [LIBRARY_STATS_REFRESH_DELAY_MS, LIBRARY_STATS_REFRESH_DELAY_MS]);
  assert.equal(seen[0].songs, 80);
  assert.equal(seen[1].songs, 81);
});

test("unready stats retry only a bounded number of times", async () => {
  const seen: LibraryStatsResponse[] = [];
  let reads = 0;
  await refreshLibraryStatsWhileStale(
    async () => { reads++; return snapshot({ ready: false, stale: false, songs: 0, updatedAt: null }); },
    (value) => seen.push(value),
    () => true,
    async () => {},
  );
  assert.equal(reads, LIBRARY_STATS_REFRESH_ATTEMPTS);
  assert.equal(seen.length, LIBRARY_STATS_REFRESH_ATTEMPTS);
});

test("refresh work stops after the view is disposed", async () => {
  let active = true;
  let reads = 0;
  await refreshLibraryStatsWhileStale(
    async () => { reads++; return snapshot({ stale: true }); },
    () => { active = false; },
    () => active,
    async () => {},
  );
  assert.equal(reads, 1);
});

test("rebuild access requires admin level and reclaim permission", () => {
  assert.equal(canRebuildLibraryStats(false, true), false);
  assert.equal(canRebuildLibraryStats(true, false), false);
  assert.equal(canRebuildLibraryStats(true, true), true);
});
