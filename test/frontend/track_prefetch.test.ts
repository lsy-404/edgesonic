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

// Contract and cache checks for next-track lyrics, metadata, and cover preloading.
// Run: npx tsx test/frontend/track_prefetch.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getTrackLyrics,
  getTrackMetadataXml,
  preloadTrack,
  type PrefetchTrack,
  type TrackPrefetchAuth,
} from "../../web/src/lib/trackPrefetch";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const track: PrefetchTrack = { id: "song-prefetch", title: "Next", artist: "Artist", coverArt: "al-cover" };

async function run() {
  const calls: string[] = [];
  const auth: TrackPrefetchAuth = {
    scope: "prefetch-cache-test",
    authFetch: async (pathName) => {
      calls.push(pathName);
      if (pathName === "getSong") return '<song id="song-prefetch" title="Next" />';
      if (pathName === "getLyricsBySongId") return '<structuredLyrics><line start="1000">Next line</line></structuredLyrics>';
      return "";
    },
    coverArtUrl: (id, size) => `/cover/${id}?size=${size}`,
  };

  const metadataA = await getTrackMetadataXml(track, auth);
  const metadataB = await getTrackMetadataXml(track, auth);
  assert(metadataA === metadataB, "metadata cache returns the same response");
  assert(calls.filter((name) => name === "getSong").length === 1, "metadata request is deduplicated");

  const lyricsA = await getTrackLyrics(track, auth);
  const lyricsB = await getTrackLyrics(track, auth);
  assert(lyricsA.structured?.includes("Next line") === true, "structured lyrics are cached");
  assert(lyricsA === lyricsB, "lyrics cache returns the same payload");
  assert(calls.filter((name) => name === "getLyricsBySongId").length === 1, "lyrics request is deduplicated");

  const coverUrls: string[] = [];
  const OriginalImage = globalThis.Image;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      coverUrls.push(value);
      queueMicrotask(() => this.onload?.());
    }
  }
  globalThis.Image = FakeImage as unknown as typeof Image;
  try {
    const preloadAuth: TrackPrefetchAuth = {
      ...auth,
      scope: "prefetch-entry-test",
      authFetch: auth.authFetch,
    };
    preloadTrack(track, preloadAuth);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.Image = OriginalImage;
  }
  assert(coverUrls.includes("/cover/al-cover?size=512"), "shared large cover is preloaded");
  assert(!coverUrls.includes("/cover/al-cover?size=96"), "duplicate small-cover preload is avoided");

  const playerSrc = fs.readFileSync(path.resolve(__dirname, "../../web/src/stores/player.ts"), "utf8");
  const nowPlayingSrc = fs.readFileSync(path.resolve(__dirname, "../../web/src/views/NowPlaying.vue"), "utf8");
  assert(playerSrc.includes("preloadTrack(nextTrack"), "next-track ancillary preload is wired up");
  // Metadata/lyrics/covers are small: they must fire on the timing gate alone.
  // Sitting behind the current track's full-file fetch means a slow or failed
  // fetch silently cancels every prefetch.
  const ancillaryAt = playerSrc.indexOf("prefetchNextTrackData();");
  // Audio waits for a safe playback runway; ancillary data does not.
  const audioGateAt = playerSrc.indexOf("bufferedAhead(el) >= NEXT_TRACK_PRELOAD_BUFFER_SECONDS");
  assert(
    ancillaryAt >= 0 && audioGateAt >= 0 && ancillaryAt < audioGateAt,
    "ancillary prefetch is not gated on the current track being fully buffered",
  );
  assert(nowPlayingSrc.includes("getTrackLyrics(trackAtChange"), "detail lyrics reuse the normalized preload cache");

  const fileCalls: string[] = [];
  const fileTrack: PrefetchTrack = { id: "file-id", libraryId: "catalog-id", title: "File", artist: "Artist" };
  const fileAuth: TrackPrefetchAuth = {
    ...auth,
    scope: "file-catalog-cache-test",
    authFetch: async (pathName, params) => {
      fileCalls.push(`${pathName}:${params?.id}`);
      return pathName === "getLyricsBySongId"
        ? '<structuredLyrics><line start="0">Catalog</line></structuredLyrics>'
        : '<song id="catalog-id" />';
    },
  };
  preloadTrack(fileTrack, fileAuth);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await getTrackLyrics(fileTrack, fileAuth);
  assert(fileCalls.filter((call) => call === "getLyricsBySongId:catalog-id").length === 1,
    "file prefetch and detail lyrics share one catalog-id request");

  let recoveryCalls = 0;
  const aborted = new AbortController();
  const recoveryAuth: TrackPrefetchAuth = {
    ...auth,
    scope: "prefetch-recovery-test",
    authFetch: async (_path, _params, signal) => {
      recoveryCalls++;
      if (recoveryCalls === 1) {
        aborted.abort(new DOMException("cancelled", "AbortError"));
        throw signal?.reason;
      }
      return '<structuredLyrics><line start="0">Recovered</line></structuredLyrics>';
    },
  };
  await getTrackLyrics(track, recoveryAuth, aborted.signal).catch(() => {});
  const recovered = await getTrackLyrics(track, recoveryAuth);
  assert(recoveryCalls === 2 && recovered.structured?.includes("Recovered"), "aborted lyrics prefetch is removed from the cache");

  let immediateCalls = 0;
  const owner = new AbortController();
  const immediateAuth: TrackPrefetchAuth = {
    ...auth,
    scope: "immediate-cancellation-test",
    authFetch: (_path, _params, signal) => {
      if (++immediateCalls > 1) return Promise.resolve('<structuredLyrics><line start="0">Fresh</line></structuredLyrics>');
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
  const oldRequest = getTrackLyrics(track, immediateAuth, owner.signal).catch(() => {});
  owner.abort();
  const freshRequest = getTrackLyrics(track, immediateAuth);
  assert(immediateCalls === 2, "same-turn reopen cannot reuse an already-aborted cache entry");
  assert((await freshRequest).structured?.includes("Fresh"), "a stale rejection cannot remove the replacement cache entry");
  await oldRequest;

  let completeShared!: (xml: string) => void;
  let sharedCalls = 0;
  const sharedAuth: TrackPrefetchAuth = {
    ...auth,
    scope: "shared-cancellation-test",
    authFetch: () => { sharedCalls++; return new Promise((resolve) => { completeShared = resolve; }); },
  };
  const shared = getTrackLyrics(track, sharedAuth);
  const waiter = new AbortController();
  const joined = getTrackLyrics(track, sharedAuth, waiter.signal).then(() => false, () => true);
  waiter.abort();
  assert(await joined, "a canceled cache waiter stops waiting immediately");
  completeShared('<structuredLyrics><line start="0">Shared</line></structuredLyrics>');
  assert(sharedCalls === 1 && (await shared).structured?.includes("Shared"), "canceling a waiter preserves the shared request for its owner");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
