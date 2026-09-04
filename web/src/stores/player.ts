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

import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useAuth, parseXmlAttrs } from "../api";
import { getTrackMetadataXml, preloadTrack } from "../lib/trackPrefetch";
import { getCachedTrack, putCachedTrack, deleteCachedTrack } from "../lib/audioCache";
import { setPlaybackActive } from "../lib/requestBudget";
import { beginAudioRequest, beginRequest, describeAudio, endAudioRequest } from "../lib/netDiag";
import { repairFlacPictureMime } from "../lib/flacRepair";
import { extractEmbeddedCover } from "../lib/embeddedCover";
import { i18n } from "../i18n";
import { showError } from "./toast";
import { setupMediaSession, syncMediaSession, clearMediaSession } from "../lib/mediaSession";

export interface Track {
  id: string;
  libraryId?: string;
  title: string;
  artist: string;
  album: string;
  streamUrl?: string;
  coverArt?: string;
  duration: number;
  starred?: boolean;
  starredAt?: string;
  createdAt?: string;
  artistId?: string;
  albumId?: string;
}

interface IncrementalFallbackState {
  trackId: string;
  sourceUrl: string;
  chunks: Blob[];
  downloaded: number;
  stepIndex: number;
  contentType: string;
  shouldPlay: boolean;
  phase: "range" | "full";
  controller: AbortController;
}

interface FullDownloadState {
  trackId: string;
  controller: AbortController;
}

interface PreloadedTrack {
  el: HTMLAudioElement;
  index: number;
  ready: boolean;
}

/**
 * Player store — owns two <audio> elements (double buffering) and the queue.
 *
 * Stream URLs are freshly signed per call (t = md5(sessionToken + salt)), so a
 * preloaded track can NOT be replayed via browser HTTP cache — the inactive
 * element preloads the next track and is swapped in on next()/ended.
 */
export const usePlayerStore = defineStore("player", () => {
  const PLAYER_SESSION_KEYS = [
    "edgesonic:queue",
    "edgesonic:currentIndex",
    "edgesonic:currentTime",
    "edgesonic:playMode",
    "edgesonic:playing",
  ];
  for (const key of PLAYER_SESSION_KEYS) localStorage.removeItem(key);
  const playbackStorage = sessionStorage;

  const queue = ref<Track[]>([]);
  const index = ref(-1);
  const playing = ref(false);
  const currentTime = ref(0);
  const duration = ref(0);
  const volume = ref(parseFloat(
    localStorage.getItem("edgesonic:volume") ||
    localStorage.getItem("edgesonic_volume") ||
    "0.8"
  ));
  // Playback quality — a persistent personal preference like volume, not
  // per-session playback state. "auto" means no format/maxBitRate params:
  // the server serves the stored instance as-is. Any other value maps to a
  // /rest/stream format+maxBitRate pair (see QUALITY_OPTIONS); the server
  // gracefully falls back to raw when the engine can't honour it, so an
  // invalid/stale saved preference is never a hard failure.
  const QUALITY_OPTIONS: Record<string, { format?: string; maxBitRate?: number }> = {
    auto: {},
    "mp3-128": { format: "mp3", maxBitRate: 128 },
    "mp3-192": { format: "mp3", maxBitRate: 192 },
    "aac-128": { format: "aac", maxBitRate: 128 },
    "opus-128": { format: "opus", maxBitRate: 128 },
    flac: { format: "flac" },
    wav: { format: "wav" },
  };
  const playbackQuality = ref(
    (() => {
      const saved = localStorage.getItem("edgesonic:playbackQuality") || "auto";
      return saved in QUALITY_OPTIONS ? saved : "auto";
    })(),
  );
  function streamQualityParams(): { format?: string; maxBitRate?: number } | undefined {
    const opts = QUALITY_OPTIONS[playbackQuality.value];
    return opts && Object.keys(opts).length ? opts : undefined;
  }
  // The IndexedDB blob cache (audioCache.ts) is keyed by whatever string we
  // hand it — folding the quality selection in means a cached blob is never
  // served for a different quality than it was fetched at, and switching
  // quality naturally starts a fresh fetch instead of replaying stale audio.
  function cacheKeyFor(trackId: string): string {
    return `${trackId}::${playbackQuality.value}`;
  }
  const QUALITY_RANK: Record<string, number> = {
    "mp3-128": 1,
    "aac-128": 2,
    "mp3-192": 3,
    "opus-128": 3,
    flac: 4,
    wav: 4,
    auto: 5,
  };
  const QUALITY_MIME: Record<string, string> = {
    "mp3-128": "audio/mpeg",
    "aac-128": "audio/mp4; codecs=mp4a.40.2",
    "mp3-192": "audio/mpeg",
    "opus-128": "audio/ogg; codecs=opus",
    flac: "audio/flac",
    wav: "audio/wav",
  };
  function canUseCachedQuality(candidate: string, requested: string): boolean {
    // "auto" describes an unknown source quality, so it is only safe as an
    // exact hit. Known higher-quality formats must also be browser-playable.
    if (candidate === "auto") return requested === "auto";
    if (typeof Audio === "undefined") return true;
    return new Audio().canPlayType(QUALITY_MIME[candidate] || "") !== "";
  }
  function cacheKeyCandidates(trackId: string, quality: string): string[] {
    const minRank = QUALITY_RANK[quality] ?? 0;
    return Object.keys(QUALITY_RANK)
      .filter((candidate) => QUALITY_RANK[candidate] >= minRank && canUseCachedQuality(candidate, quality))
      .sort((a, b) => QUALITY_RANK[a] - QUALITY_RANK[b])
      .map((candidate) => `${trackId}::${candidate}`);
  }
  async function getCachedTrackAtOrAboveQuality(trackId: string): Promise<{ blob: Blob; key: string } | null> {
    for (const key of cacheKeyCandidates(trackId, playbackQuality.value)) {
      const blob = await getCachedTrack(key);
      if (blob) return { blob, key };
    }
    return null;
  }
  // Buffered range tracking for the PlayerBar buffer bar overlay.
  // `bufferedRanges` is an array of [startSec, endSec] tuples representing
  // the byte ranges the browser has fetched so far. Updated on `progress`
  // events from the active <audio> element (fires ~4×/s during download).
  const bufferedRanges = ref<[number, number][]>([]);

  // Single cycling play mode (replaces the old independent repeatMode +
  // shuffle toggles — the UI now exposes exactly one button that cycles
  // sequential -> single -> shuffle -> sequential, matching how most music
  // players present this). "sequential" loops the whole queue at the end
  // (there is no standalone "stop at end" state anymore).
  type PlayMode = "sequential" | "single" | "shuffle";
  const playMode = ref<PlayMode>(
    (playbackStorage.getItem("edgesonic:playMode") as PlayMode) || "sequential"
  );
  // Internal shuffle order — the actual queue array is never shuffled; instead
  // we maintain a parallel index order for shuffle playback.
  let _shuffleOrder: number[] = [];

  const current = computed<Track | null>(() => queue.value[index.value] || null);
  const hasTrack = computed(() => index.value >= 0 && index.value < queue.value.length);

  function trackForId(trackId: string): Track | undefined {
    return current.value?.id === trackId ? current.value : queue.value.find((track) => track.id === trackId);
  }

  function sourceUrlForTrack(track: Track): string {
    return track.streamUrl || useAuth().streamUrl(track.id, streamQualityParams());
  }

  function sourceUrlForId(trackId: string): string {
    const track = trackForId(trackId);
    return track ? sourceUrlForTrack(track) : useAuth().streamUrl(trackId, streamQualityParams());
  }

  function catalogId(track: Track): string {
    return track.libraryId || track.id;
  }

  function hydrateTrack(trackId: string, details: Partial<Track>) {
    const trackIndex = queue.value.findIndex((track) => track.id === trackId);
    if (trackIndex < 0) return;
    queue.value.splice(trackIndex, 1, { ...queue.value[trackIndex], ...details });
  }

  let _resumePlayback = false;

  watch(playing, setPlaybackActive, { immediate: true });

  // ---- Favorite (Subsonic star/unstar) ----
  // Queue entries (built ad hoc by each view from search3/getAlbum/etc. XML)
  // don't carry a `starred` field, so we look it up fresh per track via
  // getSong rather than threading it through every call site that builds a
  // Track. `current.value?.id !== id` guards against a stale response
  // landing after the user has already skipped to another track.
  const starred = ref(false);
  let starredRequest = 0;

  function applyStarred(id: string, value: boolean) {
    for (const track of queue.value) {
      if (catalogId(track) === id) track.starred = value;
    }
    if (current.value && catalogId(current.value) === id) starred.value = value;
  }

  function setStarred(id: string, value: boolean) {
    starredRequest++;
    applyStarred(id, value);
  }

  async function _refreshStarred(id: string) {
    const request = ++starredRequest;
    try {
      const { authFetch, username } = useAuth();
      const xml = await getTrackMetadataXml({ id }, { authFetch, scope: username.value });
      if (request !== starredRequest || !current.value || catalogId(current.value) !== id) return;
      applyStarred(id, !!parseXmlAttrs(xml, "song")[0]?.starred);
    } catch {
      if (request === starredRequest && current.value && catalogId(current.value) === id) applyStarred(id, false);
    }
  }
  watch(current, (tr) => {
    if (!tr) { starredRequest++; starred.value = false; return; }
    void _refreshStarred(catalogId(tr));
  }, { immediate: true });

  async function toggleStar() {
    const tr = current.value;
    if (!tr) return;
    const next = !starred.value;
    const request = ++starredRequest;
    const id = catalogId(tr);
    applyStarred(id, next); // optimistic
    try {
      const { authFetch } = useAuth();
      await authFetch(next ? "star" : "unstar", { id });
    } catch {
      if (request === starredRequest && current.value && catalogId(current.value) === id) applyStarred(id, !next); // revert on failure
    }
  }

  // When getCoverArt 404s the buffered song bytes often still carry embedded
  // art the server couldn't reach (bounded head slice, unreachable source).
  // UI reports the miss via reportCoverMissing(); extraction runs against the
  // in-memory full blob or the IndexedDB copy, and re-fires when a full
  // download completes later. Object URL lifetime is one track.
  const localCoverUrl = ref("");
  let coverMissingTrackId: string | null = null;
  const fullBlobByElement = new Map<HTMLAudioElement, Blob>();

  function clearLocalCover() {
    if (localCoverUrl.value) URL.revokeObjectURL(localCoverUrl.value);
    localCoverUrl.value = "";
    coverMissingTrackId = null;
  }
  watch(() => current.value?.id, () => clearLocalCover());

  async function tryLocalCoverFrom(blob: Blob, trackId: string) {
    if (localCoverUrl.value || coverMissingTrackId !== trackId) return;
    const pic = await extractEmbeddedCover(blob);
    if (!pic || coverMissingTrackId !== trackId || current.value?.id !== trackId) return;
    localCoverUrl.value = URL.createObjectURL(pic);
    console.info("[Player] cover 404 → embedded art extracted from buffered audio", { trackId, size: pic.size, type: pic.type });
  }

  async function reportCoverMissing() {
    const tr = current.value;
    if (!tr) return;
    if (coverMissingTrackId === tr.id && localCoverUrl.value) return;
    coverMissingTrackId = tr.id;
    const inMemory = active ? fullBlobByElement.get(active) : undefined;
    if (inMemory) {
      await tryLocalCoverFrom(inMemory, tr.id);
      if (localCoverUrl.value) return;
    }
    const cached = await getCachedTrackAtOrAboveQuality(tr.id);
    if (cached) await tryLocalCoverFrom(cached.blob, tr.id);
  }

  let elA: HTMLAudioElement | null = null;
  let elB: HTMLAudioElement | null = null;
  let active: HTMLAudioElement | null = null;

  function mediaArtworkUrl(coverId: string): string {
    return `/rest/getCoverArt?${new URLSearchParams({
      v: "1.16.1",
      c: "EdgeSonicWeb",
      id: coverId,
      size: "512",
    }).toString()}`;
  }

  function syncMediaControls() {
    syncMediaSession(current.value ? {
      title: current.value.title,
      artist: current.value.artist,
      album: current.value.album,
      artwork: current.value.coverArt ? mediaArtworkUrl(current.value.coverArt) : undefined,
    } : null,
      !current.value ? "none" : playing.value ? "playing" : "paused",
      active && duration.value > 0 ? { duration: duration.value, position: currentTime.value } : undefined);
  }
  watch([current, playing, currentTime, duration], syncMediaControls, { immediate: true });
  setupMediaSession({
    currentTime: () => currentTime.value,
    play: () => { if (!playing.value) toggle(); },
    pause: () => { if (playing.value) toggle(); },
    previous: prev,
    next,
    seek,
  });
  let preloaded: PreloadedTrack | null = null;
  let _isUnloading = false;
  // Pending seek position to restore after loadedmetadata fires (page-reload resume).
  let _pendingRestoreTime: number | null = null;
  // Guards the ~4×/s timeupdate gate from re-queueing the same prefetch.
  let prefetchedTrackId: string | null = null;
  const FALLBACK_RANGE_STEPS = [1_200_000, 2_400_000, 4_800_000, 9_600_000];
  const blobSrcByElement = new WeakMap<HTMLAudioElement, string>();
  const fallbackAttemptByElement = new WeakMap<HTMLAudioElement, string>();
  const fallbackStateByElement = new WeakMap<HTMLAudioElement, IncrementalFallbackState>();
  const fallbackTerminalTrackByElement = new WeakMap<HTMLAudioElement, string>();
  const fullDownloadByElement = new WeakMap<HTMLAudioElement, FullDownloadState>();
  const fullBlobOriginByElement = new WeakMap<HTMLAudioElement, "background" | "fallback">();
  const fullyLoadedByElement = new WeakSet<HTMLAudioElement>();
  // Tracks which manual-cache key (see cacheKeyFor) actually supplied the
  // blob currently loaded into an element, when it came from that cache at
  // all. Lets fallbackAfterMediaError evict the exact broken entry instead
  // of guessing at the current quality selection, which can differ from
  // what was actually served once cross-quality substitution is in play.
  const cachedBlobKeyByElement = new WeakMap<HTMLAudioElement, string>();
  const fallbackInFlight = new WeakSet<HTMLAudioElement>();
  const internalPauseByElement = new WeakSet<HTMLAudioElement>();

  window.addEventListener("pagehide", () => {
    _isUnloading = true;
    playbackStorage.setItem("edgesonic:playing", playing.value ? "1" : "0");
    if (hasTrack.value) {
      const position = active && Number.isFinite(active.currentTime) ? active.currentTime : currentTime.value;
      playbackStorage.setItem("edgesonic:currentTime", String(Math.floor(position)));
    }
  });
  window.addEventListener("pageshow", () => { _isUnloading = false; });

  // Playback watchdog: "playing" state with a frozen clock and starved buffer
  // means the element is waiting on a hung transfer — surface a snapshot so
  // the hang is visible even when no stalled/error event ever fires.
  const PLAYBACK_WATCHDOG_MS = 8_000;
  let _watchdogLastTime = -1;
  setInterval(() => {
    const el = active;
    if (!el || !playing.value || el.paused || el.ended || document.hidden) {
      _watchdogLastTime = -1;
      return;
    }
    const t = el.currentTime;
    if (_watchdogLastTime >= 0 && t === _watchdogLastTime && el.readyState < 3) {
      console.warn("[Player] watchdog: playback frozen with starved buffer", describeAudio(el));
    }
    _watchdogLastTime = t;
  }, PLAYBACK_WATCHDOG_MS);

  function revokeBlobSrc(el: HTMLAudioElement) {
    endAudioRequest(el, "replaced by Blob");
    const blobSrc = blobSrcByElement.get(el);
    if (blobSrc) {
      URL.revokeObjectURL(blobSrc);
      blobSrcByElement.delete(el);
    }
    fullBlobByElement.delete(el);
  }

  function abortFullDownload(el: HTMLAudioElement) {
    const state = fullDownloadByElement.get(el);
    if (!state) return;
    state.controller.abort();
    fullDownloadByElement.delete(el);
  }

  function abortFallbackWork(el: HTMLAudioElement) {
    fallbackStateByElement.get(el)?.controller.abort();
    fallbackInFlight.delete(el);
  }

  function pauseInternally(el: HTMLAudioElement) {
    internalPauseByElement.add(el);
    try { el.pause(); } finally { internalPauseByElement.delete(el); }
  }

  function resetFallbackState(el: HTMLAudioElement) {
    abortFallbackWork(el);
    endAudioRequest(el);
    abortFullDownload(el);
    revokeBlobSrc(el);
    fallbackAttemptByElement.delete(el);
    fallbackStateByElement.delete(el);
    fallbackInFlight.delete(el);
    fallbackTerminalTrackByElement.delete(el);
    fullBlobOriginByElement.delete(el);
    fullyLoadedByElement.delete(el);
    cachedBlobKeyByElement.delete(el);
  }

  async function blobHeadHex(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
  }

  async function logFallbackBlob(label: string, resp: Response, blob: Blob) {
    console.info("[Player] fallback fetch", {
      label,
      status: resp.status,
      contentType: resp.headers.get("Content-Type") || blob.type || "",
      contentRange: resp.headers.get("Content-Range") || "",
      contentLength: resp.headers.get("Content-Length") || "",
      blobSize: blob.size,
      headHex: await blobHeadHex(blob),
    });
  }

  async function normalizePlayableBlob(blob: Blob): Promise<Blob> {
    const type = blob.type.toLowerCase();
    if (!type.includes("flac")) return blob;

    const probe = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer());
    if (probe.length >= 4 && probe[0] === 0x66 && probe[1] === 0x4c && probe[2] === 0x61 && probe[3] === 0x43) {
      const repaired = await repairFlacPictureMime(blob);
      if (repaired) {
        console.info("[Player] repaired FLAC picture MIME", { originalSize: blob.size, repairedSize: repaired.size });
        return repaired;
      }
      return blob;
    }

    let flacOffset = -1;
    for (let i = 0; i <= probe.length - 4; i++) {
      if (probe[i] === 0x66 && probe[i + 1] === 0x4c && probe[i + 2] === 0x61 && probe[i + 3] === 0x43) {
        flacOffset = i;
        break;
      }
    }
    if (flacOffset <= 0) return blob;

    console.info("[Player] normalized FLAC blob", {
      removedPrefixBytes: flacOffset,
      originalSize: blob.size,
      normalizedSize: blob.size - flacOffset,
    });
    const sliced = blob.slice(flacOffset, blob.size, blob.type || "audio/flac");
    const repaired = await repairFlacPictureMime(sliced);
    if (repaired) {
      console.info("[Player] repaired FLAC picture MIME", { originalSize: sliced.size, repairedSize: repaired.size });
      return repaired;
    }
    return sliced;
  }

  async function fetchFullBlob(trackId: string, signal?: AbortSignal, priority?: "low"): Promise<Blob> {
    const { downloadUrl } = useAuth();
    let lastError: unknown = null;
    // Stream first: it is the same URL the <audio> element uses, so both share
    // one HTTP cache entry. /rest/download is a different URL and would always
    // cost a separate transfer. Letting the browser cache also means a replay
    // or a seek can be served locally instead of re-fetching the whole file.
    //
    // Each attempt gets its own timeout. A presign 302 whose cached Location
    // expired can hang the fetch indefinitely; without a timeout the
    // background-download slot leaks and the next-track preload starves.
    const ATTEMPT_TIMEOUT_MS = 60_000;
    const quality = streamQualityParams();
    const track = trackForId(trackId);
    const attempts: Array<readonly [string, string]> = [["stream-full", sourceUrlForId(trackId)]];
    // Download always returns the original file, so it is only a valid retry
    // when the user explicitly selected automatic/original quality.
    if (!track?.streamUrl && !quality) attempts.push(["download-full", downloadUrl(trackId)]);
    for (const [label, url] of attempts) {
      const attemptController = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; attemptController.abort(); }, ATTEMPT_TIMEOUT_MS);
      // Tie the attempt to the caller's signal so a skip/track change still
      // cancels immediately, even mid-timeout.
      const onAbort = () => attemptController.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const diag = beginRequest(label, url);
      try {
        const started = performance.now();
        const requestInit: RequestInit & { priority?: "low" } = {
          credentials: "same-origin",
          signal: attemptController.signal,
          // Keep redirects followable so 302 to R2 still works; the timeout
          // above bounds the worst case.
        };
        if (priority) requestInit.priority = priority;
        const resp = await fetch(url, requestInit);
        const ttfbMs = Math.round(performance.now() - started);
        // resp.url is the post-redirect URL — it exposes whether the transfer
        // went direct to object storage (presign 302) or through the Worker.
        console.info("[Player] fallback response", {
          label,
          status: resp.status,
          finalHost: (() => { try { return new URL(resp.url).host; } catch { return resp.url; } })(),
          redirected: resp.redirected,
          ttfbMs,
          contentLength: resp.headers.get("Content-Length") || "",
        });
        if (!resp.ok) throw new Error(`fallback fetch failed: ${resp.status}`);
        let blob: Blob;
        const reader = resp.body?.getReader();
        if (reader) {
          // Read the body in chunks so the diagnostics registry sees live
          // progress — a transfer that stops mid-body is then distinguishable
          // from one that never got its first byte.
          const parts: BlobPart[] = [];
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            received += value.byteLength;
            diag.progress(received);
          }
          blob = new Blob(parts, { type: resp.headers.get("Content-Type") || "" });
        } else {
          blob = await resp.blob();
          diag.progress(blob.size);
        }
        diag.end({ status: resp.status, redirected: resp.redirected });
        await logFallbackBlob(label, resp, blob);
        return blob;
      } catch (e) {
        diag.fail(timedOut ? `attempt timeout ${ATTEMPT_TIMEOUT_MS} ms` : e);
        if (signal?.aborted) throw e;
        lastError = e;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastError ?? new Error("fallback fetch failed");
  }

  function playPreparedBlob(
    el: HTMLAudioElement,
    blob: Blob,
    resumeAt: number,
    shouldPlay: boolean,
    completeOrigin: "background" | "fallback" | null,
    cacheKey?: string,
  ) {
    revokeBlobSrc(el);
    if (cacheKey) cachedBlobKeyByElement.set(el, cacheKey);
    else cachedBlobKeyByElement.delete(el);
    if (completeOrigin) {
      fullyLoadedByElement.add(el);
      fullBlobOriginByElement.set(el, completeOrigin);
      fullBlobByElement.set(el, blob);
      // A cover miss reported before the bytes were complete retries here.
      const trId = current.value?.id;
      if (el === active && trId && coverMissingTrackId === trId) void tryLocalCoverFrom(blob, trId);
    } else {
      fullyLoadedByElement.delete(el);
      fullBlobOriginByElement.delete(el);
      fullBlobByElement.delete(el);
    }
    const blobSrc = URL.createObjectURL(blob);
    blobSrcByElement.set(el, blobSrc);
    el.src = blobSrc;
    el.load();
    if (resumeAt > 0) {
      const onMeta = () => {
        el.currentTime = Math.min(resumeAt, Number.isFinite(el.duration) ? el.duration : resumeAt);
        el.removeEventListener("loadedmetadata", onMeta);
      };
      el.addEventListener("loadedmetadata", onMeta);
    }
    if (shouldPlay) void el.play().catch(() => { playing.value = false; });
  }

  async function playFallbackBlob(
    el: HTMLAudioElement,
    blob: Blob,
    resumeAt: number,
    shouldPlay: boolean,
    completeOrigin: "background" | "fallback" | null = null,
  ) {
    const playableBlob = await normalizePlayableBlob(blob);
    playPreparedBlob(el, playableBlob, resumeAt, shouldPlay, completeOrigin);
  }

  function advanceAfterFallbackFailure(el: HTMLAudioElement, trackId: string, reason: unknown) {
    if (el !== active || current.value?.id !== trackId) return;
    if (fallbackTerminalTrackByElement.get(el) === trackId) return;
    fallbackTerminalTrackByElement.set(el, trackId);
    abortFullDownload(el);
    revokeBlobSrc(el);
    fallbackAttemptByElement.delete(el);
    fallbackStateByElement.delete(el);
    fullBlobOriginByElement.delete(el);
    fullyLoadedByElement.delete(el);
    playing.value = false;
    console.error("[Player] all playback attempts failed, skipping track:", reason);
    showError(i18n.global.t("player.playbackFailed", { title: current.value?.title || "" }));
    next();
  }

  async function fallbackToFullBlob(
    el: HTMLAudioElement,
    state: IncrementalFallbackState,
    resumeAt: number,
    shouldPlay: boolean,
  ) {
    state.phase = "full";
    try {
      const blob = await fetchFullBlob(state.trackId, state.controller.signal);
      if (el !== active || current.value?.id !== state.trackId) return;
      await playFallbackBlob(el, blob, resumeAt, state.shouldPlay || shouldPlay, "fallback");
      fallbackStateByElement.delete(el);
    } catch (e) {
      if (state.controller.signal.aborted) return;
      console.error("[Player] full-file fallback failed:", e);
      advanceAfterFallbackFailure(el, state.trackId, e);
    }
  }

  async function continueIncrementalFallback(el: HTMLAudioElement, state: IncrementalFallbackState, resumeAt: number, shouldPlay: boolean) {
    if (el !== active || fallbackInFlight.has(el) || state.controller.signal.aborted) return;
    const track = current.value;
    if (!track || track.id !== state.trackId) return;

    fallbackInFlight.add(el);
    try {
      while (state.stepIndex < FALLBACK_RANGE_STEPS.length) {
        const target = FALLBACK_RANGE_STEPS[state.stepIndex++];
        if (target <= state.downloaded) continue;
        // This runs only after playback already failed, so it deliberately
        // keeps no-store: recovery must never be served a cached copy of
        // whatever the browser could not play.
        const diag = beginRequest(`stream-range-${state.downloaded}-${target - 1}`, state.sourceUrl);
        const attemptController = new AbortController();
        const RANGE_STALL_TIMEOUT_MS = 20_000;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        let stalled = false;
        const resetStallTimer = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => { stalled = true; attemptController.abort(); }, RANGE_STALL_TIMEOUT_MS);
        };
        const abortAttempt = () => attemptController.abort();
        state.controller.signal.addEventListener("abort", abortAttempt, { once: true });
        resetStallTimer();
        let resp!: Response;
        let chunk!: Blob;
        try {
          resp = await fetch(state.sourceUrl, {
            credentials: "same-origin",
            cache: "no-store",
            headers: { Range: `bytes=${state.downloaded}-${target - 1}` },
            signal: attemptController.signal,
          });
          if (!resp.ok) {
            attemptController.abort();
            throw new Error(`range fallback fetch failed: ${resp.status}`);
          }
          const reader = resp.body?.getReader();
          if (reader) {
            const parts: BlobPart[] = [];
            let received = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parts.push(value);
              received += value.byteLength;
              diag.progress(received);
              resetStallTimer();
            }
            chunk = new Blob(parts, { type: resp.headers.get("Content-Type") || "" });
          } else {
            chunk = await resp.blob();
            diag.progress(chunk.size);
          }
          diag.end({ status: resp.status });
        } catch (e) {
          attemptController.abort();
          diag.fail(stalled
            ? `range stalled for ${RANGE_STALL_TIMEOUT_MS} ms`
            : e);
          throw e;
        } finally {
          if (stallTimer) clearTimeout(stallTimer);
          state.controller.signal.removeEventListener("abort", abortAttempt);
        }
        await logFallbackBlob(`stream-range-${state.downloaded}-${target - 1}`, resp, chunk);
        if (resp.status === 206) {
          state.chunks.push(chunk);
          state.downloaded += chunk.size;
          state.contentType = state.contentType || chunk.type || resp.headers.get("Content-Type") || "";
          if (chunk.size < target - (state.downloaded - chunk.size)) state.stepIndex = FALLBACK_RANGE_STEPS.length;
        } else {
          state.chunks = [chunk];
          state.downloaded = chunk.size;
          state.contentType = chunk.type || resp.headers.get("Content-Type") || state.contentType;
          state.stepIndex = FALLBACK_RANGE_STEPS.length;
        }

        if (el !== active || current.value?.id !== state.trackId) return;
        const blob = new Blob(state.chunks, { type: state.contentType || undefined });
        await playFallbackBlob(el, blob, resumeAt, state.shouldPlay || shouldPlay);
        return;
      }
    } catch (e) {
      if (state.controller.signal.aborted) return;
      console.warn("[Player] incremental fallback failed, trying full file:", e);
      state.stepIndex = FALLBACK_RANGE_STEPS.length;
    } finally {
      if (fallbackStateByElement.get(el) === state) fallbackInFlight.delete(el);
    }

    if (el === active && current.value?.id === state.trackId) {
      await fallbackToFullBlob(el, state, resumeAt, state.shouldPlay || shouldPlay);
    }
  }

  function beginIncrementalFallback(el: HTMLAudioElement, trackId: string, resumeAt: number, shouldPlay: boolean) {
    const state: IncrementalFallbackState = {
      trackId,
      sourceUrl: sourceUrlForId(trackId),
      chunks: [],
      downloaded: 0,
      stepIndex: 0,
      contentType: "",
      shouldPlay,
      phase: "range",
      controller: new AbortController(),
    };
    fallbackStateByElement.set(el, state);
    void continueIncrementalFallback(el, state, resumeAt, shouldPlay);
  }

  function fallbackAfterMediaError(el: HTMLAudioElement, failedSrc: string, shouldPlay: boolean) {
    if (!failedSrc) return;
    const track = current.value;
    if (!track) return;
    const resumeAt = Number.isFinite(el.currentTime) ? el.currentTime : currentTime.value;

    if (failedSrc.startsWith("blob:")) {
      const state = fallbackStateByElement.get(el);
      if (blobSrcByElement.get(el) !== failedSrc) return;
      // An unplayable blob must not stay in the manual cache, or every later
      // play would be served the same broken copy before falling back. Evict
      // the exact key that supplied this element.
      const brokenKey = cachedBlobKeyByElement.get(el);
      if (brokenKey) void deleteCachedTrack(brokenKey);
      if (state?.phase === "range") {
        void continueIncrementalFallback(el, state, resumeAt, shouldPlay);
      } else if (state?.phase === "full") {
        advanceAfterFallbackFailure(el, track.id, new Error("full fallback blob is not playable"));
      } else if (fullBlobOriginByElement.get(el) === "background") {
        fullyLoadedByElement.delete(el);
        fullBlobOriginByElement.delete(el);
        beginIncrementalFallback(el, track.id, resumeAt, shouldPlay);
      } else {
        advanceAfterFallbackFailure(el, track.id, new Error("playback blob is not playable"));
      }
      return;
    }

    if (el !== active) return;
    abortFullDownload(el);
    if (fallbackTerminalTrackByElement.get(el) === track.id) return;
    if (fallbackAttemptByElement.get(el) === failedSrc) return;
    fallbackAttemptByElement.set(el, failedSrc);
    beginIncrementalFallback(el, track.id, resumeAt, shouldPlay);
  }

  function startFullDownload(
    el: HTMLAudioElement,
    trackId: string,
    onComplete: (blob: Blob) => Promise<void> | void,
    onFailure: (error: unknown) => void,
  ) {
    abortFullDownload(el);
    const state: FullDownloadState = {
      trackId,
      controller: new AbortController(),
    };
    fullDownloadByElement.set(el, state);
    void fetchFullBlob(trackId, state.controller.signal, "low")
      .then(async (blob) => {
        if (fullDownloadByElement.get(el) !== state) return;
        await onComplete(blob);
        if (fullDownloadByElement.get(el) === state) fullDownloadByElement.delete(el);
      })
      .catch((error: unknown) => {
        if (fullDownloadByElement.get(el) !== state) return;
        fullDownloadByElement.delete(el);
        if (!state.controller.signal.aborted) onFailure(error);
      });
  }

  function syncBuffered(el: HTMLAudioElement) {
    if (el !== active) return;
    const next: [number, number][] = [];
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration.value;
    if (fullyLoadedByElement.has(el) && dur > 0) {
      next.push([0, dur]);
    } else {
      try {
        for (let i = 0; i < el.buffered.length; i++) {
          const start = el.buffered.start(i);
          const end = el.buffered.end(i);
          if (end - start > 0.05) next.push([start, end]);
        }
      } catch { /* buffered not ready yet */ }
    }
    // Shallow-compare to avoid ref churn when nothing moved.
    const prev = bufferedRanges.value;
    if (prev.length !== next.length ||
        next.some((r, i) => r[0] !== prev[i][0] || r[1] !== prev[i][1])) {
      bufferedRanges.value = next;
    }
  }

  // Start the next low-priority download as soon as active playback has enough
  // runway to absorb bandwidth fluctuations. The deadline still guarantees a
  // late start when a browser reports sparse or discontinuous buffered ranges.
  const NEXT_TRACK_PRELOAD_BUFFER_SECONDS = 20;
  const NEXT_TRACK_PRELOAD_FORCE_SECONDS = 15;

  function isFullyBuffered(el: HTMLAudioElement, dur: number): boolean {
    if (fullyLoadedByElement.has(el)) return true;
    try {
      const n = el.buffered.length;
      return n > 0 && el.buffered.end(n - 1) >= dur - 0.5;
    } catch {
      return false;
    }
  }

  function bufferedAhead(el: HTMLAudioElement): number {
    try {
      for (let i = 0; i < el.buffered.length; i++) {
        if (el.buffered.start(i) <= el.currentTime + 0.1 && el.buffered.end(i) >= el.currentTime) {
          return Math.max(0, el.buffered.end(i) - el.currentTime);
        }
      }
    } catch { /* buffered not ready yet */ }
    return 0;
  }

  function makeAudio(): HTMLAudioElement {
    const el = new Audio();
    // `preload="auto"` is only a browser hint; explicit next-track preloading
    // consumes the full response once active playback has a safe runway.
    el.preload = "auto";
    el.volume = volume.value;
    el.addEventListener("timeupdate", () => {
      if (el !== active) return;
      currentTime.value = el.currentTime;
      const dur = el.duration;
      if (isFinite(dur) && dur > 0) {
        const remaining = dur - el.currentTime;
        prefetchNextTrackData();
        if (isFullyBuffered(el, dur)
            || bufferedAhead(el) >= NEXT_TRACK_PRELOAD_BUFFER_SECONDS
            || remaining <= NEXT_TRACK_PRELOAD_FORCE_SECONDS) preloadNext();
      }
    });
    el.addEventListener("durationchange", () => {
      if (el === active && isFinite(el.duration)) {
        duration.value = el.duration;
        syncBuffered(el);
      }
    });
    el.addEventListener("play", () => {
      console.log("[Player] play event, src =", el.src);
      if (el === active) playing.value = true;
    });
    el.addEventListener("pause", () => {
      console.log("[Player] pause event");
      if (el === active) {
        playing.value = false;
        if (!internalPauseByElement.has(el)) abortFallbackWork(el);
        invalidatePreload();
      }
    });
    el.addEventListener("ended", () => {
      console.log("[Player] ended event");
      if (el === active) next();
    });
    el.addEventListener("error", (e) => {
      const failedSrc = el.currentSrc || el.src;
      const shouldPlay = playing.value || !el.paused;
      console.error("[Player] audio error event:", el.error ? {
        code: el.error.code,
        message: el.error.message
      } : e, "src =", el.src);
      if (el === active) {
        playing.value = false;
        const code = el.error?.code;
        if (failedSrc && (code === 2 || code === 3 || code === 4)) {
          fallbackAfterMediaError(el, failedSrc, shouldPlay);
        }
      } else if (preloaded?.el === el) {
        // A speculative failure does not prove the track is unplayable. Keep
        // it unready so advancing retries through the normal streaming path.
        preloaded.ready = false;
        abortFullDownload(el);
      }
    });
    el.addEventListener("stalled", () => {
      console.warn("[Player] stalled event (buffering stalled)", describeAudio(el));
    });
    el.addEventListener("waiting", () => {
      console.log("[Player] waiting event (waiting for data)", describeAudio(el));
    });
    el.addEventListener("loadedmetadata", () => {
      console.log("[Player] loadedmetadata event, duration =", el.duration);
    });
    el.addEventListener("canplay", () => {
      console.log("[Player] canplay event");
    });
    el.addEventListener("progress", () => syncBuffered(el));
    return el;
  }

  function ensureElements() {
    if (!elA) elA = makeAudio();
    if (!elB) elB = makeAudio();
    if (!active) active = elA;
  }

  function inactiveEl(): HTMLAudioElement {
    return active === elA ? elB! : elA!;
  }

  function invalidatePreload() {
    if (preloaded) {
      resetFallbackState(preloaded.el);
      preloaded.el.removeAttribute("src");
      preloaded.el.preload = "auto";
      preloaded.el.load();
      preloaded = null;
    }
  }

  watch(playbackQuality, (value) => {
    localStorage.setItem("edgesonic:playbackQuality", value);
    invalidatePreload();
    if (!active?.currentSrc || !hasTrack.value) return;
    const resumeAt = Number.isFinite(active.currentTime) ? active.currentTime : currentTime.value;
    const shouldPlay = playing.value || !active.paused;
    _pendingRestoreTime = resumeAt;
    loadCurrent(shouldPlay);
  });

  /**
   * Index the queue will actually advance to, mirroring next(). Returns -1 when
   * there is nothing to prepare or the target cannot be predicted.
   */
  function upcomingIndex(): number {
    if (!hasTrack.value) return -1;
    if (playMode.value === "single") return -1;
    if (playMode.value === "shuffle") return _shuffleNextIndex(index.value);
    if (index.value < queue.value.length - 1) return index.value + 1;
    return queue.value.length > 1 ? 0 : -1;
  }

  /** Warm the small per-track data (metadata, lyrics, cover art) for the next entry. */
  function prefetchNextTrackData() {
    const ni = upcomingIndex();
    if (ni < 0 || ni === index.value) return;
    const nextTrack = queue.value[ni];
    if (!nextTrack || prefetchedTrackId === nextTrack.id) return;
    prefetchedTrackId = nextTrack.id;
    if (nextTrack.streamUrl) return;
    const { authFetch, coverArtUrl, username } = useAuth();
    preloadTrack(nextTrack, { authFetch, coverArtUrl, scope: username.value });
  }

  /** Fully prebuffer the next queue entry into the inactive element. */
  function preloadNext() {
    ensureElements();
    const ni = upcomingIndex();
    if (ni < 0 || ni === index.value) { invalidatePreload(); return; }
    if (preloaded?.index === ni) return;
    invalidatePreload();
    const nextTrack = queue.value[ni];
    const el = inactiveEl();
    resetFallbackState(el);
    pauseInternally(el);
    el.removeAttribute("src");
    el.load();
    el.preload = "auto";
    const candidate: PreloadedTrack = { el, index: ni, ready: false };
    preloaded = candidate;
    // A native audio element may stop an auto preload after a small buffer.
    // Consume the complete response ourselves, then hand the ready Blob to
    // the inactive element for an instant swap. A hit in the manual cache
    // skips the download entirely.
    void (async () => {
      const cached = await getCachedTrackAtOrAboveQuality(nextTrack.id);
      if (preloaded !== candidate || el === active) return;
      if (cached) {
        playPreparedBlob(el, cached.blob, 0, false, "background", cached.key);
        candidate.ready = true;
        return;
      }
      const fetchedKey = cacheKeyFor(nextTrack.id);
      startFullDownload(
        el,
        nextTrack.id,
        async (blob) => {
          const playableBlob = await normalizePlayableBlob(blob);
          void putCachedTrack(fetchedKey, playableBlob, nextTrack.duration || 0);
          if (preloaded !== candidate || el === active) return;
          playPreparedBlob(el, playableBlob, 0, false, "background", fetchedKey);
          candidate.ready = true;
        },
        (error) => {
          if (preloaded === candidate) {
            candidate.ready = false;
            console.warn("[Player] next-track preload failed; normal streaming will retry on advance:", error);
          }
        },
      );
    })();
  }

  function loadCurrent(autoplay = true) {
    const track = current.value;
    if (!track) return;
    ensureElements();
    prefetchedTrackId = null;
    // If restoring a saved position, show it immediately; otherwise reset to 0.
    currentTime.value = _pendingRestoreTime ?? 0;
    duration.value = track.duration || 0;
    bufferedRanges.value = [];

    if (preloaded && preloaded.index === index.value && preloaded.ready) {
      // Swap in the prebuffered element — instant start
      const next = preloaded.el;
      preloaded = null;
      pauseInternally(active!);
      resetFallbackState(active!);
      active!.removeAttribute("src");
      active!.load();
      active = next;
      syncBuffered(active);
    } else {
      invalidatePreload();
      pauseInternally(active!);
      resetFallbackState(active!);
      const targetEl = active!;
      const trackId = track.id;
      targetEl.removeAttribute("src");
      targetEl.load();
      if (track.streamUrl) {
        beginAudioRequest(targetEl, "audio-stream", track.streamUrl);
        targetEl.src = track.streamUrl;
        targetEl.load();
        targetEl.volume = volume.value;
        if (_pendingRestoreTime !== null) {
          const t = _pendingRestoreTime;
          _pendingRestoreTime = null;
          const onMeta = () => {
            if (active) { active.currentTime = t; currentTime.value = t; }
            active?.removeEventListener("loadedmetadata", onMeta);
          };
          targetEl.addEventListener("loadedmetadata", onMeta);
        }
        if (autoplay) void targetEl.play().catch(() => { playing.value = false; });
        return;
      }
      const requestedQuality = playbackQuality.value;
      // Manual cache first: a hit plays the whole track locally with zero
      // network. On a miss, stream directly for fast start. Do not also fetch
      // the full file here: two transfers for the active track compete on slow
      // links, and switching to the completed Blob interrupts live playback.
      // Clearing the old source before the async lookup prevents its media
      // events from restoring the previous time.
      void (async () => {
        const cached = await getCachedTrackAtOrAboveQuality(trackId);
        if (active !== targetEl || current.value?.id !== trackId || playbackQuality.value !== requestedQuality) return;
        if (cached) {
          const resumeAt = _pendingRestoreTime ?? 0;
          _pendingRestoreTime = null;
          targetEl.volume = volume.value;
          playPreparedBlob(targetEl, cached.blob, resumeAt, autoplay, "background", cached.key);
          syncBuffered(targetEl);
          // Blob URLs don't fire `progress` (no network fetch), and
          // `durationchange` only fires on an actual duration change. When
          // track.duration is 0 the eager syncBuffered above writes [] and
          // nothing else repopulates the bar. Re-sync once on metadata so the
          // real el.duration drives the fully-loaded [0,dur] segment.
          const onMeta = () => {
            if (active !== targetEl) return;
            if (isFinite(targetEl.duration) && targetEl.duration > 0) {
              duration.value = targetEl.duration;
              syncBuffered(targetEl);
            }
            targetEl.removeEventListener("loadedmetadata", onMeta);
          };
          targetEl.addEventListener("loadedmetadata", onMeta);
          return;
        }
        const sourceUrl = sourceUrlForTrack(track);
        beginAudioRequest(targetEl, "audio-stream", sourceUrl);
        targetEl.src = sourceUrl;
        targetEl.load();
        targetEl.volume = volume.value;

        // One-shot seek to restored position once audio metadata is available.
        if (_pendingRestoreTime !== null) {
          const t = _pendingRestoreTime;
          _pendingRestoreTime = null;
          const onMeta = () => {
            if (active) { active.currentTime = t; currentTime.value = t; }
            active?.removeEventListener("loadedmetadata", onMeta);
          };
          targetEl.addEventListener("loadedmetadata", onMeta);
        }

        if (autoplay) void targetEl.play().catch(() => { playing.value = false; });
      })();
      return;
    }
    active!.volume = volume.value;

    // One-shot seek to restored position once audio metadata is available.
    if (_pendingRestoreTime !== null) {
      const t = _pendingRestoreTime;
      _pendingRestoreTime = null;
      const onMeta = () => {
        if (active) { active.currentTime = t; currentTime.value = t; }
        active?.removeEventListener("loadedmetadata", onMeta);
      };
      active!.addEventListener("loadedmetadata", onMeta);
    }

    if (autoplay) void active!.play().catch(() => { playing.value = false; });
  }

  /** Replace queue and start playing at startIndex. */
  function setQueue(tracks: Track[], startIndex = 0) {
    _pendingRestoreTime = null; // cancel any page-reload restore when user starts a new queue
    invalidatePreload();
    queue.value = tracks;
    index.value = tracks.length ? Math.min(Math.max(startIndex, 0), tracks.length - 1) : -1;
    loadCurrent();
  }

  /**
   * Queue a track to play right after the current one. With nothing playing
   * this behaves as "play now"; a track already queued is moved rather than
   * duplicated.
   */
  function playNext(track: Track) {
    if (!queue.value.length || index.value < 0) {
      setQueue([track], 0);
      return;
    }
    const existing = queue.value.findIndex((q) => q.id === track.id);
    if (existing === index.value) return;
    const rest = existing >= 0
      ? queue.value.filter((_, i) => i !== existing)
      : queue.value.slice();
    // Removing an earlier entry shifts the cursor back with it.
    const cursor = existing >= 0 && existing < index.value ? index.value - 1 : index.value;
    rest.splice(cursor + 1, 0, track);
    queue.value = rest;
    index.value = cursor;
    invalidatePreload();
  }

  function playAt(i: number) {
    if (i < 0 || i >= queue.value.length) return;
    _pendingRestoreTime = null; // cancel restore when user explicitly navigates
    index.value = i;
    loadCurrent();
  }

  function toggle() {
    if (!hasTrack.value) return;
    ensureElements();
    // Audio not loaded yet (e.g. page-reload with restored queue) — load and play.
    // _pendingRestoreTime (if set) will seek to the saved position via loadedmetadata.
    if (!active!.currentSrc) {
      loadCurrent(true);
      return;
    }
    if (active!.paused) void active!.play().catch(() => { playing.value = false; });
    else active!.pause();
  }

  function _regenShuffleOrder() {
    const indices = queue.value.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    _shuffleOrder = indices;
  }

  function _shuffleNextIndex(currentIdx: number): number {
    if (_shuffleOrder.length === 0 || !_shuffleOrder.includes(currentIdx)) {
      _regenShuffleOrder();
      // Move current to front so it doesn't replay immediately.
      const pos = _shuffleOrder.indexOf(currentIdx);
      if (pos > 0) { _shuffleOrder.splice(pos, 1); _shuffleOrder.unshift(currentIdx); }
    }
    const pos = _shuffleOrder.indexOf(currentIdx);
    if (pos < 0) return currentIdx;
    if (pos + 1 < _shuffleOrder.length) return _shuffleOrder[pos + 1];
    return -1; // end of shuffle order — caller regenerates and wraps
  }

  function next() {
    if (playMode.value === "single") {
      // Repeat current track
      if (active) { active.currentTime = 0; void active.play().catch(() => {}); }
      return;
    }
    if (playMode.value === "shuffle") {
      const ni = _shuffleNextIndex(index.value);
      if (ni >= 0) playAt(ni);
      else if (queue.value.length > 0) {
        _regenShuffleOrder();
        playAt(_shuffleOrder[0]);
      } else playing.value = false;
      return;
    }
    if (index.value < queue.value.length - 1) playAt(index.value + 1);
    else if (queue.value.length > 0) playAt(0);
    else playing.value = false;
  }

  function prev() {
    if (!active) return;
    // Restart current track if more than 3s in, like most players.
    if (active.currentTime > 3) { active.currentTime = 0; return; }
    if (playMode.value === "shuffle") {
      const pos = _shuffleOrder.indexOf(index.value);
      if (pos > 0) { playAt(_shuffleOrder[pos - 1]); return; }
      active.currentTime = 0; return;
    }
    if (index.value > 0) playAt(index.value - 1);
    else active.currentTime = 0;
  }

  function seek(seconds: number) {
    if (!hasTrack.value || !active) return;
    active.currentTime = Math.min(Math.max(seconds, 0), duration.value || 0);
    currentTime.value = active.currentTime;
  }

  function setVolume(v: number) {
    volume.value = Math.min(Math.max(v, 0), 1);
    if (elA) elA.volume = volume.value;
    if (elB) elB.volume = volume.value;
    localStorage.setItem("edgesonic:volume", String(volume.value));
  }

  /** Cycle sequential -> single -> shuffle -> sequential. */
  function cyclePlayMode() {
    playMode.value =
      playMode.value === "sequential" ? "single" :
      playMode.value === "single" ? "shuffle" : "sequential";
    playbackStorage.setItem("edgesonic:playMode", playMode.value);
    if (playMode.value === "shuffle" && queue.value.length > 0) _regenShuffleOrder();
    else _shuffleOrder = [];
  }

  /** Stop playback and clear queue (e.g. on logout). */
  function clear() {
    _pendingRestoreTime = null;
    invalidatePreload();
    for (const el of [elA, elB]) {
      if (el) { pauseInternally(el); resetFallbackState(el); el.removeAttribute("src"); el.load(); }
    }
    queue.value = [];
    index.value = -1;
    playing.value = false;
    clearMediaSession();
    currentTime.value = 0;
    duration.value = 0;
    bufferedRanges.value = [];
    // Clear persisted player state on logout so the next session starts fresh.
    for (const key of PLAYER_SESSION_KEYS) playbackStorage.removeItem(key);
  }

  // ---- page-session persistence ----

  /** Serialize queue to minimal objects (stream URLs are generated on demand). */
  function _saveQueueAndIndex() {
    const slim = queue.value.map((t) => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album,
      ...(t.coverArt !== undefined ? { coverArt: t.coverArt } : {}),
      duration: t.duration,
    }));
    playbackStorage.setItem("edgesonic:queue", JSON.stringify(slim));
    playbackStorage.setItem("edgesonic:currentIndex", String(index.value));
  }

  let _lastTimeSave = 0;

  // Restore persisted state on store init (runs once, synchronously).
  try {
    const rawQueue = playbackStorage.getItem("edgesonic:queue");
    if (rawQueue) {
      const saved = JSON.parse(rawQueue) as Track[];
      if (Array.isArray(saved) && saved.length > 0) {
        const rawIdx = parseInt(playbackStorage.getItem("edgesonic:currentIndex") ?? "", 10);
        const savedIdx = isNaN(rawIdx) ? 0 : Math.min(Math.max(rawIdx, 0), saved.length - 1);
        const rawTime = parseFloat(playbackStorage.getItem("edgesonic:currentTime") ?? "");
        queue.value = saved;
        index.value = savedIdx;
        duration.value = saved[savedIdx].duration || 0;
        if (!isNaN(rawTime) && rawTime > 0) {
          _pendingRestoreTime = rawTime;
          currentTime.value = rawTime; // show saved position in UI immediately
        }
        _resumePlayback = playbackStorage.getItem("edgesonic:playing") === "1";
      }
    }
  } catch { /* corrupt localStorage — skip silently */ }

  // Persist queue + index whenever either changes (deep: array mutations included).
  watch([queue, index], _saveQueueAndIndex, { deep: true });

  // Throttle currentTime writes to at most once per 5 s to avoid excessive I/O.
  watch(currentTime, () => {
    if (_isUnloading) return;
    const now = Date.now();
    if (now - _lastTimeSave >= 5000) {
      playbackStorage.setItem("edgesonic:currentTime", String(Math.floor(currentTime.value)));
      _lastTimeSave = now;
    }
  });

  watch(playing, (isPlaying) => {
    if (_isUnloading) return;
    if (!isPlaying && !hasTrack.value) playbackStorage.removeItem("edgesonic:playing");
    else playbackStorage.setItem("edgesonic:playing", isPlaying ? "1" : "0");
  });

  function resumePlaybackIfNeeded() {
    if (!_resumePlayback || !hasTrack.value) return;
    _resumePlayback = false;
    loadCurrent(true);
  }

  // Volume is already written in setVolume(); watch covers direct ref mutations.
  watch(volume, (v) => localStorage.setItem("edgesonic:volume", String(v)));

  return {
    queue, index, playing, currentTime, duration, volume, bufferedRanges,
    current, hasTrack, playMode, starred, localCoverUrl, playbackQuality,
    setQueue, hydrateTrack, playNext, playAt, toggle, next, prev, seek, setVolume,
    cyclePlayMode, toggleStar, setStarred, clear, resumePlaybackIfNeeded, reportCoverMissing,
  };
});
