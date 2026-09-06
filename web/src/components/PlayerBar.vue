
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "../stores/player";
import { useDetailStore } from "../stores/detail";
import { useAuth, formatDuration } from "../api";
import { activeTheme } from "../theme";
import { getTheme } from "../themes/registry";
import { isOutsideElements } from "../lib/outsideClick";
import Icon from "./Icon.vue";

const { t } = useI18n();
const player = usePlayerStore();
const detail = useDetailStore();
const { coverArtUrl } = useAuth();

const activeThemeDef = computed(() => getTheme(activeTheme.value));

const detailsOpen = computed(() => detail.kind === "now-playing");

function goNowPlaying() {
  if (!player.hasTrack) return;
  detail.toggleNowPlaying();
}

const playModeTitle = computed(() => t(`player.playMode.${player.playMode}`));
// Mirrors the QUALITY_OPTIONS keys in stores/player.ts — kept as a plain id
// list here (rather than importing the map) since the UI only needs the ids
// to build <option> elements; the format/maxBitRate mapping is the store's
// concern.
const QUALITY_SELECT_OPTIONS = [
  { id: "auto" },
  { id: "mp3-128", mime: "audio/mpeg" },
  { id: "mp3-192", mime: "audio/mpeg" },
  { id: "aac-128", mime: "audio/mp4; codecs=mp4a.40.2" },
  { id: "opus-128", mime: "audio/ogg; codecs=opus" },
  { id: "flac", mime: "audio/flac" },
  { id: "wav", mime: "audio/wav" },
];
const supportedQualityOptions = computed(() => QUALITY_SELECT_OPTIONS.filter((option) => {
  if (!option.mime || typeof Audio === "undefined") return true;
  return new Audio().canPlayType(option.mime) !== "";
}));
watch(supportedQualityOptions, (options) => {
  if (!options.some((option) => option.id === player.playbackQuality)) player.playbackQuality = "auto";
}, { immediate: true });
const expandTitle = computed(() => t(detailsOpen.value ? "player.collapse" : "player.expand"));

const coverFailed = ref(false);
const coverSrc = computed(() => {
  const tr = player.current;
  return tr?.coverArt ? coverArtUrl(tr.coverArt, 96) : "";
});
// Server cover 404 (or track without a cover id): fall back to embedded art
// extracted from the buffered audio bytes by the player store.
const displayCoverSrc = computed(() => (!coverFailed.value && coverSrc.value) || player.localCoverUrl || "");
function onCoverError() {
  coverFailed.value = true;
  void player.reportCoverMissing();
}
watch(coverSrc, (src) => {
  coverFailed.value = false;
  if (!src && player.hasTrack) void player.reportCoverMissing();
}, { immediate: true });

const bufferedSegments = computed(() => {
  if (!Number.isFinite(player.duration) || player.duration <= 0) return [] as { left: number; width: number }[];
  return player.bufferedRanges.map(([s, e]) => ({
    left: Math.min(Math.max((s / player.duration) * 100, 0), 100),
    width: Math.min(Math.max(((e - s) / player.duration) * 100, 0), 100),
  }));
});

const progressEl = ref<HTMLElement | null>(null);
const dragging = ref(false);
const dragTime = ref<number | null>(null);

const displayTime = computed(() => dragTime.value ?? player.currentTime);
const progressPct = computed(() => {
  const duration = player.duration;
  const time = displayTime.value;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(time)) return 0;
  return Math.min(100, Math.max(0, (time / duration) * 100));
});
const coverProgressOffset = computed(() => 176 * (1 - progressPct.value / 100));

function fmtPrecise(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00.00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function seekFromEvent(e: PointerEvent): number | null {
  const el = progressEl.value;
  if (!el || player.duration <= 0) return null;
  const rect = el.getBoundingClientRect();
  const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  return ratio * player.duration;
}

let removeDragListeners: (() => void) | null = null;

function stopProgressDrag(commit: boolean) {
  const target = dragTime.value;
  dragTime.value = null;
  dragging.value = false;
  removeDragListeners?.();
  removeDragListeners = null;
  if (commit && target !== null) player.seek(target);
}

function onProgressPointerDown(e: PointerEvent) {
  if (!player.hasTrack) return;
  e.preventDefault();
  stopProgressDrag(false);
  progressEl.value?.setPointerCapture?.(e.pointerId);
  dragging.value = true;
  dragTime.value = seekFromEvent(e);
  const move = (ev: PointerEvent) => { dragTime.value = seekFromEvent(ev); };
  const up = () => stopProgressDrag(true);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
  window.addEventListener("pointercancel", up, { once: true });
  removeDragListeners = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
}

onBeforeUnmount(() => stopProgressDrag(false));

function onVolume(e: Event) {
  player.setVolume(parseFloat((e.target as HTMLInputElement).value));
}

const queueOpen = ref(false);
const queueButton = ref<HTMLElement | null>(null);
const queuePanel = ref<HTMLElement | null>(null);
const queueList = ref<HTMLElement | null>(null);
watch(detailsOpen, (open) => { if (!open) queueOpen.value = false; });
async function revealCurrentQueueItem() {
  await nextTick();
  queueList.value?.querySelector<HTMLElement>(".pb-queue-item.playing")?.scrollIntoView({ block: "center" });
}
watch(queueOpen, (open) => { if (open) void revealCurrentQueueItem(); });
watch(() => player.index, () => { if (queueOpen.value) void revealCurrentQueueItem(); });
function playFromQueue(i: number) { player.playAt(i); }
function removeFromQueue(i: number) {
  if (i === player.index) return;
  player.queue.splice(i, 1);
  if (i < player.index) player.index--;
}
function onDocumentPointerDown(e: PointerEvent) {
  if (!queueOpen.value) return;
  if (isOutsideElements(e.target, [queuePanel.value, queueButton.value])) queueOpen.value = false;
}
onMounted(() => document.addEventListener("pointerdown", onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown));
</script>

<template>
  <footer class="player-bar" :class="{ 'details-open': detailsOpen }">
    <!-- Track info -->
    <div
      class="pb-track"
      :class="{ clickable: player.hasTrack }"
      @click="goNowPlaying"
    >
      <div class="pb-cover" :class="{ clickable: player.hasTrack }" :title="player.hasTrack ? expandTitle : ''">
        <img v-if="displayCoverSrc" :src="displayCoverSrc" alt="" @error="onCoverError" />
        <Icon v-else name="music" :size="20" />
        <svg v-if="player.hasTrack" class="pb-cover-ring" viewBox="0 0 48 48" aria-hidden="true">
          <path class="pb-cover-ring-track" d="M24 2H46V46H2V2H24" pathLength="176" />
          <path class="pb-cover-ring-fill" d="M24 2H46V46H2V2H24" pathLength="176" :style="{ strokeDashoffset: coverProgressOffset }" />
        </svg>
      </div>
      <div v-if="player.current" class="pb-meta" :class="{ clickable: player.hasTrack }" :title="expandTitle">
        <div class="pb-title" :title="player.current.title">{{ player.current.title }}</div>
        <div class="pb-artist">{{ player.current.artist || t("player.unknownArtist") }}</div>
      </div>
      <div v-else class="pb-meta">
        <div class="pb-empty">{{ t("player.noTrack") }}</div>
        <div class="pb-empty-sub">{{ t("player.selectSong") }}</div>
      </div>
    </div>

    <!-- Controls + progress -->
    <div class="pb-center">
      <div class="pb-controls">
        <button class="pb-btn pb-fav" :class="{ active: player.starred }" :disabled="!player.hasTrack" :title="player.starred ? t('player.unlike') : t('player.like')" @click="player.toggleStar()">
          <Icon name="heart" :size="16" />
        </button>
        <button class="pb-btn" :disabled="!player.hasTrack" :title="`${t('player.previous')} (Shift+P)`" @click="player.prev()">
          <Icon name="previous" :size="16" />
        </button>
        <button class="pb-btn pb-play" :disabled="!player.hasTrack" :title="`${player.playing ? t('player.pause') : t('player.play')} (Space / K)`" @click="player.toggle()">
          <Icon :name="player.playing ? 'pause' : 'play'" :size="18" />
        </button>
        <button class="pb-btn" :disabled="!player.hasTrack" :title="`${t('player.next')} (Shift+N)`" @click="player.next()">
          <Icon name="next" :size="16" />
        </button>
        <button class="pb-btn pb-mode" :class="{ active: player.playMode !== 'sequential' }" :disabled="!player.hasTrack" :title="playModeTitle" @click="player.cyclePlayMode()">
          <Icon :name="player.playMode === 'shuffle' ? 'shuffle' : player.playMode === 'single' ? 'repeatOne' : 'repeat'" :size="16" />
        </button>
      </div>
      <div class="pb-progress-row">
        <span class="pb-time">{{ formatDuration(Math.floor(displayTime)) }}</span>
        <div ref="progressEl" class="pb-progress" :class="{ disabled: !player.hasTrack }" :title="t('player.seekShortcut')" @pointerdown="onProgressPointerDown">
          <div
            v-for="(seg, i) in bufferedSegments"
            :key="i"
            class="pb-progress-buffered"
            :style="{ left: seg.left + '%', width: seg.width + '%' }"
          ></div>
          <div class="pb-progress-fill" :style="{ width: progressPct + '%' }"></div>
          <div class="pb-progress-thumb" :class="{ active: dragging }" :style="{ left: progressPct + '%' }">
            <component :is="activeThemeDef?.progressThumb" v-if="activeThemeDef?.progressThumb" />
          </div>
          <div v-if="dragging" class="pb-progress-tooltip" :style="{ left: progressPct + '%' }">{{ fmtPrecise(displayTime) }}</div>
        </div>
        <span class="pb-time">{{ formatDuration(Math.floor(player.duration)) }}</span>
      </div>
    </div>

    <!-- Volume + Queue toggle -->
    <div class="pb-right">
      <div class="pb-quality-wrap">
        <select
          class="pb-quality"
          v-model="player.playbackQuality"
          :title="t('player.quality.title')"
          :aria-label="t('player.quality.title')"
        >
          <option v-for="opt in supportedQualityOptions" :key="opt.id" :value="opt.id">{{ t(`player.quality.${opt.id}`) }}</option>
        </select>
        <Icon class="pb-quality-caret" name="chevronDown" :size="10" />
      </div>
      <input
        class="pb-volume"
        type="range" min="0" max="1" step="0.01"
        :value="player.volume"
        @input="onVolume"
        :title="`${t('player.volume')} (↑ / ↓, M)`"
      />
      <button ref="queueButton" class="pb-queue-btn" :class="{ active: queueOpen }" @click="queueOpen = !queueOpen" :title="t('player.queueTitle', { n: player.queue.length })">
        <Icon name="queueNext" :size="16" />
        <span class="pb-queue-count" v-if="player.queue.length">{{ player.queue.length }}</span>
      </button>
    </div>

    <!-- Queue panel (slides up from player bar) -->
    <transition name="queue-up">
      <div v-if="queueOpen" ref="queuePanel" class="pb-queue-panel">
        <div class="pb-queue-header">
          <span>{{ t("player.queueTitle", { n: player.queue.length }) }}</span>
          <button class="pb-queue-close" @click="queueOpen = false">
            <Icon name="cross" :size="16" />
          </button>
        </div>
        <div ref="queueList" class="pb-queue-list">
          <div
            v-for="(tr, i) in player.queue"
            :key="tr.id + '-' + i"
            class="pb-queue-item"
            :class="{ playing: i === player.index }"
            @click="playFromQueue(i)"
          >
           <span class="pb-queue-idx">{{ String(i + 1).padStart(2, "0") }}</span>
            <div class="pb-queue-meta">
              <div class="pb-queue-title">{{ tr.title }}</div>
              <div class="pb-queue-artist">{{ tr.artist }}</div>
            </div>
            <span class="pb-queue-dur">{{ formatDuration(Math.floor(tr.duration)) }}</span>
            <button v-if="i !== player.index" class="pb-queue-rm" @click.stop="removeFromQueue(i)">
              <Icon name="cross" :size="14" />
            </button>
          </div>
          <div v-if="player.queue.length === 0" class="pb-queue-empty">{{ t("player.queueEmpty") }}</div>
        </div>
      </div>
    </transition>
  </footer>
</template>

<style scoped>
.player-bar {
  position: fixed;
  left: 0; right: 0; bottom: var(--bottom-nav-space, 0px);
  height: var(--player-h);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0 1.25rem;
  background: rgba(10, 10, 11, 0.95);
  backdrop-filter: blur(12px);
  border-top: 1px solid var(--color-border-subtle);
}

/* --- track info --- */
.pb-track { display: flex; align-items: center; gap: 0.8rem; width: 240px; min-width: 0; flex-shrink: 0; }
.pb-cover {
  width: 44px; height: 44px; flex-shrink: 0;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  color: var(--color-text-muted);
}
.pb-cover.clickable, .pb-meta.clickable { cursor: pointer; }
.pb-cover.clickable:hover { border-color: var(--color-accent-dim); }
.pb-meta.clickable:hover .pb-title { color: var(--color-accent-primary); }
.pb-cover img { width: 100%; height: 100%; object-fit: cover; }
.pb-cover-ring {
  display: none;
  position: absolute;
  inset: -4px;
  width: calc(100% + 8px);
  height: calc(100% + 8px);
  overflow: visible;
  pointer-events: none;
}
.pb-cover-ring-track,
.pb-cover-ring-fill {
  fill: none;
  stroke-width: 2;
}
.pb-cover-ring-track { stroke: var(--color-border-subtle); }
.pb-cover-ring-fill {
  stroke: var(--color-accent-primary);
  stroke-dasharray: 176 176;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: stroke-dashoffset 0.15s linear;
}
.pb-meta { min-width: 0; }
.pb-title {
  font-size: var(--fs-md); color: var(--color-text-primary); font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pb-artist {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted);
  letter-spacing: 0.08em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pb-empty {
  font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted);
  letter-spacing: 0.15em; animation: pulse 3s ease-in-out infinite;
}
.pb-empty-sub { font-size: var(--fs-xs); color: var(--color-text-muted); }

/* --- center controls --- */
.pb-center { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 0.15rem; }
.pb-controls { position: relative; display: flex; align-items: center; gap: 0.6rem; }
.pb-btn {
  background: none; border: none;
  color: var(--color-text-secondary);
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: color 0.2s;
  padding: 0;
}
.pb-btn:hover:not(:disabled) { color: var(--color-accent-primary); }
.pb-btn:disabled { color: var(--color-text-muted); opacity: 0.4; cursor: not-allowed; }
.pb-btn.active { color: var(--color-accent-primary); }
/* pb-mode is absolutely positioned (out of flex flow) so it doesn't skew
   the centering of the prev/play/next trio — it sits as an "extra" just past
   the trio's right edge instead of counting toward the row's own width. */
.pb-mode {
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-left: 0.6rem;
}
/* pb-fav mirrors pb-mode on the opposite side, same reasoning. */
.pb-fav {
  position: absolute;
  right: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-right: 0.6rem;
}
.pb-play {
  width: 34px; height: 34px;
  border: 1px solid var(--color-border-strong);
  border-radius: 2px;
  background: var(--color-bg-elevated);
  color: var(--color-accent-primary);
  transition: background-color 0.15s, border-color 0.15s;
}
.pb-play:hover:not(:disabled) {
  background: var(--color-accent-primary);
  color: var(--color-text-inverse);
  border-color: var(--color-accent-primary);
}

.pb-progress-row { display: flex; align-items: center; gap: 0.6rem; width: 100%; max-width: 560px; }
.pb-time {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted);
  width: 40px; text-align: center; flex-shrink: 0;
}
.pb-progress {
  position: relative; flex: 1; height: 14px;
  display: flex; align-items: center; cursor: pointer; touch-action: none;
}
.pb-progress.disabled { cursor: default; }
.pb-progress::before {
  content: ""; position: absolute; left: 0; right: 0;
  height: 3px; background: var(--color-bg-elevated);
}
.pb-progress-fill { position: absolute; left: 0; height: 3px; background: var(--color-accent-primary); }
.pb-progress-buffered {
  position: absolute;
  height: 3px;
  background: var(--color-text-secondary);
  opacity: 0.35;
  pointer-events: none;
}
.pb-progress-thumb {
  position: absolute; width: 9px; height: 9px;
  background: var(--color-accent-primary);
  transform: translateX(-50%) rotate(45deg);
  opacity: 0; transition: opacity 0.15s;
}
.pb-progress:hover .pb-progress-thumb, .pb-progress-thumb.active { opacity: 1; }
.pb-progress-tooltip {
  position: absolute;
  bottom: 16px;
  transform: translateX(-50%);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  padding: 0.2rem 0.4rem;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
}

/* --- right: quality + volume + queue --- */
.pb-right { display: flex; align-items: center; gap: 0.6rem; width: 270px; flex-shrink: 0; justify-content: flex-end; }
.pb-quality-wrap { position: relative; flex-shrink: 0; }
.pb-quality {
  appearance: none;
  width: 96px;
  height: 28px;
  background: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  padding: 0 1.3rem 0 0.55rem;
  cursor: pointer;
  transition: all 0.2s;
}
.pb-quality:hover, .pb-quality:focus { color: var(--color-accent-primary); border-color: var(--color-accent-dim); }
.pb-quality:focus { outline: none; }
.pb-quality option { background: var(--color-bg-elevated); color: var(--color-text-primary); }
.pb-quality-caret {
  position: absolute;
  right: 0.4rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-text-muted);
  pointer-events: none;
}
.pb-quality:hover ~ .pb-quality-caret,
.pb-quality:focus ~ .pb-quality-caret { color: var(--color-accent-primary); }
.pb-volume { width: 80px; accent-color: var(--color-accent-primary); cursor: pointer; }
.pb-queue-btn {
  position: relative;
  background: none; border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}
.pb-queue-btn:hover, .pb-queue-btn.active { color: var(--color-accent-primary); border-color: var(--color-accent-dim); }
.pb-queue-count {
  position: absolute;
  top: -6px; right: -6px;
  background: var(--color-accent-dim);
  color: var(--color-text-primary);
  border-radius: 8px;
  padding: 0 0.3rem;
  font-size: var(--fs-xs);
  font-family: var(--font-mono);
  min-width: 14px;
  text-align: center;
}

/* --- queue panel --- */
.pb-queue-panel {
  position: absolute;
  bottom: var(--player-h);
  right: 0;
  width: 380px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  box-shadow: 0 -4px 24px rgba(0,0,0,0.3);
  overflow: hidden;
  z-index: 200;
}
.pb-queue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
  font-weight: 500;
}
.pb-queue-close {
  background: none; border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
}
.pb-queue-close:hover { color: var(--color-text-primary); }
.pb-queue-list { overflow-y: auto; flex: 1; }
.pb-queue-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 1rem;
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
}
.pb-queue-item:hover { background: var(--color-bg-tertiary); }
.pb-queue-item.playing { color: var(--color-accent-primary); background: var(--color-bg-tertiary); }
.pb-queue-idx { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); min-width: 24px; }
.pb-queue-item.playing .pb-queue-idx { color: var(--color-accent-primary); }
.pb-queue-meta { flex: 1; min-width: 0; }
.pb-queue-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pb-queue-artist { font-size: var(--fs-xs); color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pb-queue-dur { font-family: var(--font-mono); font-size: var(--fs-xs); flex-shrink: 0; }
.pb-queue-rm {
  background: none; border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  padding: 0;
  border-radius: 50%;
  opacity: 0.5;
}
.pb-queue-rm:hover { opacity: 1; background: var(--color-accent-dim); color: var(--color-text-primary); }
.pb-queue-empty { text-align: center; padding: 2rem; color: var(--color-text-muted); }

/* Transition */
.queue-up-enter-active, .queue-up-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.queue-up-enter-from, .queue-up-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (max-width: 768px) {
  .player-bar { gap: 0.5rem; padding: 0 0.5rem; }
  .pb-track { width: auto; flex: 1; }
  .pb-right { width: auto; gap: 0.3rem; }
  .pb-volume { display: none; }
  .pb-quality-wrap { display: none; }
  .player-bar:not(.details-open) .pb-progress-row { display: none; }
  .pb-center { flex: 0 0 auto; }
  .pb-queue-panel { width: calc(100vw - 1rem); }

  .player-bar.details-open .pb-track { display: none; }
  .player-bar:not(.details-open) .pb-track {
    width: 100%;
    padding-left: 0.35rem;
    padding-right: 8rem;
  }
  .player-bar:not(.details-open) .pb-cover {
    position: relative;
    overflow: visible;
  }
  .player-bar:not(.details-open) .pb-cover-ring { display: block; }
  .player-bar:not(.details-open) .pb-center {
    position: absolute;
    right: 4rem;
    width: auto;
    flex: 0 0 auto;
  }
  .player-bar:not(.details-open) .pb-controls { gap: 0.25rem; }
  .player-bar:not(.details-open) .pb-fav,
  .player-bar:not(.details-open) .pb-mode { display: none; }
  .player-bar:not(.details-open) .pb-right,
  .player-bar.details-open .pb-right {
    display: flex;
    position: absolute;
    right: 1.25rem;
    width: auto;
    z-index: 2;
  }
  .player-bar:not(.details-open) .pb-right {
    top: 50%;
    transform: translateY(-50%);
  }
  .player-bar.details-open { justify-content: center; }
  .player-bar.details-open .pb-track { display: none; }
  .player-bar.details-open .pb-center { width: 100%; flex: 1; }
  .player-bar.details-open .pb-progress-row { max-width: none; }
  .player-bar.details-open .pb-right {
    top: 0.75rem;
    transform: none;
  }
}
</style>
