<!--
  SPDX-License-Identifier: AGPL-3.0-or-later

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program. If not, see <https://www.gnu.org/licenses/>.
-->

<!--
  A machine parked on this page is a worker, not a client. The route is marked
  `bare` so App.vue drops the sidebar, player bar and theme background layer:
  an animated background competing for GPU with ffmpeg.wasm is exactly what
  this page exists to avoid. Only occupancy is shown.
-->

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useWorkSocket } from "../stores/workSocket";
import { useAuth } from "../api";
import { taskTypeLabelKey, type WorkTaskType } from "../lib/workTypes";
import { dispatchMissingMetadataPages } from "../lib/missingMetadataDispatch";

const { t } = useI18n();
const router = useRouter();
const pool = useWorkSocket();
const { edgesonicFetch, edgesonicPost, isAdmin, hasPerm } = useAuth();
const progress = ref({ queued: 0, claimed: 0, completed: 0, failed: 0 });
const retryingFailed = ref(false);
const retryFailedError = ref<string | null>(null);
let progressPoll: number | null = null;
let mounted = false;
let progressController: AbortController | null = null;
let progressInFlight: Promise<void> | null = null;
const totalTasks = computed(() => progress.value.queued + progress.value.claimed + progress.value.completed + progress.value.failed);
const progressPct = computed(() => totalTasks.value ? Math.round(progress.value.completed / totalTasks.value * 100) : 0);

// Persisted pool state keeps the toggle aligned with the socket after reload.
const active = computed(() => pool.enabled);
// Wake Lock requires a user gesture and is released when the page is hidden.
const wakeLock = ref<WakeLockSentinel | null>(null);
const wakeLockError = ref<string | null>(null);
const wakeLockSupported = typeof navigator !== "undefined" && "wakeLock" in navigator;
const ffmpegAvailable = computed(() => pool.caps.includes("ffmpeg"));
const dispatchingLossless = ref(false);
const losslessDispatchResult = ref<string | null>(null);
const losslessDispatchError = ref<string | null>(null);
const dispatchingMissingMetadata = ref(false);
const missingMetadataProgress = ref<string | null>(null);
const missingMetadataResult = ref<string | null>(null);
const missingMetadataError = ref<string | null>(null);
let missingMetadataCursor: string | undefined;
let missingMetadataController: AbortController | null = null;
const canStart = computed(() => pool.eligible && pool.selectedTaskTypes.length > 0);
const canDispatchMissingMetadata = computed(() => hasPerm("dispatch_work") && pool.selectedTaskTypes.includes("scrape"));

function supports(type: WorkTaskType): boolean {
  return type !== "transcode" && type !== "lossless" || ffmpegAvailable.value;
}

function setSelected(type: WorkTaskType, event: Event): void {
  pool.setTaskTypeSelected(type, (event.target as HTMLInputElement).checked);
}

const now = ref(Date.now());
let tick: number | null = null;

const uptime = computed(() => {
  if (pool.linkState !== "online" || !pool.connectedAt) return "--";
  const s = Math.max(0, Math.floor((now.value - pool.connectedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
});

// The adaptive budget determines the currently available worker slots.
const slots = computed(() => {
  const busy = [...pool.running.values()];
  const width = Math.max(pool.currentConcurrency, busy.length);
  return Array.from({ length: width }, (_, i) => busy[i] ?? null);
});

async function requestWakeLock(): Promise<void> {
  if (!wakeLockSupported) { wakeLockError.value = t("workMode.wakeLockUnsupported"); return; }
  try {
    wakeLock.value = await navigator.wakeLock.request("screen");
    wakeLockError.value = null;
    wakeLock.value.addEventListener("release", () => { wakeLock.value = null; });
  } catch (e) {
    wakeLockError.value = e instanceof Error ? e.message : String(e);
  }
}

async function releaseWakeLock(): Promise<void> {
  try { await wakeLock.value?.release(); } catch { /* already released */ }
  wakeLock.value = null;
}

async function toggle(): Promise<void> {
  const next = !pool.enabled;
  pool.setEnabled(next);
  if (next) await requestWakeLock();
  else await releaseWakeLock();
}

function exit(): void {
  void router.push("/tools");
}

// Reacquire the released Wake Lock when the page returns to the foreground.
function onVisibility(): void {
  if (document.hidden) {
    if (progressPoll !== null) {
      window.clearTimeout(progressPoll);
      progressPoll = null;
    }
    if (progressController) {
      progressController.abort();
      progressController = null;
      progressInFlight = null;
    }
    return;
  }
  if (active.value && !wakeLock.value) void requestWakeLock();
  if (!document.hidden && mounted && progressPoll === null) scheduleProgressPoll();
}

function scheduleProgressPoll(): void {
  if (!mounted || document.hidden || progressPoll !== null) return;
  progressPoll = window.setTimeout(() => {
    progressPoll = null;
    void loadProgress().finally(scheduleProgressPoll);
  }, 10_000);
}

function loadProgress(): Promise<void> {
  if (progressInFlight) return progressInFlight;
  const controller = new AbortController();
  progressController = controller;
  progressInFlight = (async () => {
    try {
    const data = JSON.parse(await edgesonicFetch("work/status", { countsOnly: "1" }, controller.signal)) as { ok?: boolean; counts?: Partial<typeof progress.value> };
    if (controller.signal.aborted || !mounted) return;
    if (data.ok) progress.value = { queued: data.counts?.queued ?? 0, claimed: data.counts?.claimed ?? 0, completed: data.counts?.completed ?? 0, failed: data.counts?.failed ?? 0 };
    } catch { /* Retain the last known progress while offline. */ }
  })().finally(() => {
    if (progressController === controller) {
      progressController = null;
      progressInFlight = null;
    }
  });
  return progressInFlight;
}

async function retryFailed(): Promise<void> {
  if (retryingFailed.value || progress.value.failed === 0) return;
  retryingFailed.value = true;
  retryFailedError.value = null;
  try {
    const data = JSON.parse(await edgesonicPost("maintenance/resetFailedWork", {})) as { ok?: boolean; error?: string };
    if (!data.ok) throw new Error(data.error || "Retry failed");
    await loadProgress();
  } catch (e) {
    retryFailedError.value = e instanceof Error ? e.message : String(e);
  } finally {
    retryingFailed.value = false;
  }
}

async function dispatchLossless(): Promise<void> {
  if (!isAdmin.value || !pool.selectedTaskTypes.includes("lossless") || dispatchingLossless.value) return;
  dispatchingLossless.value = true;
  losslessDispatchError.value = null;
  losslessDispatchResult.value = null;
  try {
    const data = JSON.parse(await edgesonicPost("work/lossless/dispatch", {})) as { ok?: boolean; enqueued?: number; skipped?: number; error?: string };
    if (!data.ok) throw new Error(data.error || "Dispatch failed");
    losslessDispatchResult.value = t("workMode.losslessDispatchResult", { enqueued: data.enqueued ?? 0, skipped: data.skipped ?? 0 });
  } catch (error) {
    losslessDispatchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    dispatchingLossless.value = false;
  }
}

async function dispatchMissingMetadata(): Promise<void> {
  if (!canDispatchMissingMetadata.value || dispatchingMissingMetadata.value) return;
  dispatchingMissingMetadata.value = true;
  missingMetadataError.value = null;
  missingMetadataResult.value = null;
  missingMetadataProgress.value = t("workMode.missingMetadataDispatchStarting");
  const controller = new AbortController();
  missingMetadataController = controller;
  let scanned = 0;
  let enqueued = 0;
  let skipped = 0;
  try {
    const result = await dispatchMissingMetadataPages({
      after: missingMetadataCursor,
      signal: controller.signal,
      request: async (after, signal) => {
        const body = after === undefined ? {} : { after };
        return JSON.parse(await edgesonicPost("work/scrape/dispatch", body, signal)) as unknown;
      },
      onPage: (pageProgress) => {
        scanned = pageProgress.scanned;
        enqueued = pageProgress.enqueued;
        skipped = pageProgress.skipped;
        missingMetadataCursor = pageProgress.nextCursor;
        missingMetadataProgress.value = t("workMode.missingMetadataDispatchProgress", { scanned, enqueued, skipped });
      },
    });
    if (controller.signal.aborted || !mounted) return;
    missingMetadataCursor = result.nextCursor;
    missingMetadataResult.value = t("workMode.missingMetadataDispatchResult", { scanned, enqueued, skipped });
  } catch (error) {
    if (controller.signal.aborted || !mounted) return;
    if (scanned > 0) missingMetadataResult.value = t("workMode.missingMetadataDispatchPartial", { scanned, enqueued, skipped });
    missingMetadataError.value = t("workMode.missingMetadataDispatchError", { reason: error instanceof Error ? error.message : String(error) });
  } finally {
    if (missingMetadataController === controller) missingMetadataController = null;
    if (mounted) {
      missingMetadataProgress.value = null;
      dispatchingMissingMetadata.value = false;
      await loadProgress();
    }
  }
}

onMounted(async () => {
  mounted = true;
  tick = window.setInterval(() => { now.value = Date.now(); }, 1000);
  document.addEventListener("visibilitychange", onVisibility);
  await pool.hydrateConfig();
  if (!mounted) return;
  await loadProgress();
  if (!mounted) return;
  scheduleProgressPoll();
  if (pool.enabled) {
    if (!mounted) return;
    pool.start();
    await requestWakeLock();
  }
});

onBeforeUnmount(() => {
  mounted = false;
  if (tick !== null) window.clearInterval(tick);
  if (progressPoll !== null) window.clearTimeout(progressPoll);
  progressController?.abort();
  missingMetadataController?.abort();
  document.removeEventListener("visibilitychange", onVisibility);
  // The shared pool keeps running when this view unmounts.
  void releaseWakeLock();
});
</script>

<template>
  <div class="work-mode">
    <header class="head">
      <div class="title-row">
        <span class="dot" :class="pool.linkState"></span>
        <h1>{{ t("workMode.title") }}</h1>
      </div>
      <button class="toggle" :class="{ on: active }" :disabled="!active && !canStart" :aria-pressed="active" @click="toggle">
        <span class="toggle-indicator" aria-hidden="true"></span>
        {{ active ? t("workMode.stop") : t("workMode.start") }}
      </button>
      <button class="exit" type="button" @click="exit">{{ t("workMode.exit") }}</button>
    </header>

    <p v-if="!pool.eligible" class="notice">{{ t("workMode.ineligible") }}</p>
    <p class="intro">{{ t("workMode.description") }}</p>
    <fieldset class="task-options">
      <legend>{{ t("workMode.selectTasks") }}</legend>
      <label v-for="type in (['metadata', 'transcode', 'scrape', 'lossless'] as const)" :key="type" class="task-option" :class="{ unavailable: !supports(type) }">
        <input type="checkbox" :checked="pool.selectedTaskTypes.includes(type)" :disabled="!supports(type)" @change="setSelected(type, $event)" />
        <span>{{ t(taskTypeLabelKey(type)) }}</span>
        <small v-if="!supports(type)">{{ t("workMode.ffmpegUnavailable") }}</small>
      </label>
      <p v-if="pool.selectedTaskTypes.length === 0" class="notice">{{ t("workMode.chooseTask") }}</p>
    </fieldset>
    <section v-if="isAdmin && pool.selectedTaskTypes.includes('lossless')" class="lossless-dispatch">
      <p>{{ t("workMode.losslessDispatchHelp") }}</p>
      <button type="button" :disabled="dispatchingLossless" @click="dispatchLossless">{{ t("workMode.losslessDispatch") }}</button>
      <p v-if="losslessDispatchResult" role="status">{{ losslessDispatchResult }}</p>
      <p v-if="losslessDispatchError" class="notice">{{ losslessDispatchError }}</p>
    </section>
    <section v-if="canDispatchMissingMetadata" class="lossless-dispatch">
      <p>{{ t("workMode.missingMetadataDispatchHelp") }}</p>
      <button type="button" :disabled="dispatchingMissingMetadata" @click="dispatchMissingMetadata">
        {{ t("workMode.missingMetadataDispatch") }}
      </button>
      <p v-if="missingMetadataProgress" role="status" aria-live="polite">{{ missingMetadataProgress }}</p>
      <p v-if="missingMetadataResult" role="status">{{ missingMetadataResult }}</p>
      <p v-if="missingMetadataError" class="notice">{{ missingMetadataError }}</p>
    </section>

    <section class="gauge">
      <div class="gauge-value">{{ progress.completed }}<span class="of">/{{ totalTasks }}</span></div>
      <div class="gauge-label">{{ t("workMode.progress", { percent: progressPct }) }}</div>
      <div class="bar"><div class="fill" :style="{ width: `${progressPct}%` }"></div></div>
    </section>

    <section class="progress-counts">
      <div><span>{{ t("workMode.queued") }}</span><b>{{ progress.queued }}</b></div>
      <div><span>{{ t("workMode.inProgress") }}</span><b>{{ progress.claimed }}</b></div>
      <div><span>{{ t("workMode.completed") }}</span><b>{{ progress.completed }}</b></div>
      <div>
        <span>{{ t("workMode.failed") }}</span>
        <b>{{ progress.failed }}</b>
        <button class="retry-failed" type="button" :disabled="progress.failed === 0 || retryingFailed" @click="retryFailed">
          {{ t("workMode.retryFailed") }}
        </button>
      </div>
    </section>

    <section class="slots">
      <div v-for="(slot, i) in slots" :key="i" class="slot" :class="{ busy: !!slot }">
        <template v-if="slot">
          <span class="slot-type">{{ t(taskTypeLabelKey(slot.taskType)) }}</span>
          <span class="slot-name">{{ slot.fileName }}</span>
        </template>
        <span v-else class="slot-idle">{{ t("workMode.idle") }}</span>
      </div>
    </section>

    <section class="meters">
      <div class="meter"><span class="k">{{ t("workMode.link") }}</span><span class="v">{{ t(`workMode.state.${pool.linkState}`) }}</span></div>
      <div class="meter"><span class="k">{{ t("workMode.uptime") }}</span><span class="v">{{ uptime }}</span></div>
      <div class="meter"><span class="k">{{ t("workMode.completed") }}</span><span class="v">{{ pool.stats.completed }}</span></div>
      <div class="meter"><span class="k">{{ t("workMode.failed") }}</span><span class="v">{{ pool.stats.failed }}</span></div>
      <div class="meter"><span class="k">{{ t("workMode.reconnects") }}</span><span class="v">{{ pool.reconnects }}</span></div>
      <div class="meter"><span class="k">{{ t("workMode.speed") }}</span><span class="v">{{ pool.speedPerMin ?? "--" }}</span></div>
      <div class="meter"><span class="k">{{ t("workMode.ceiling") }}</span><span class="v">{{ pool.maxConcurrent }}</span></div>
      <div class="meter">
        <span class="k">{{ t("workMode.wakeLock") }}</span>
        <span class="v">{{ wakeLock ? t("workMode.held") : t("workMode.released") }}</span>
      </div>
    </section>
    <p class="wake-lock-note">{{ t("workMode.wakeLockHint") }}</p>

    <p v-if="wakeLockError" class="notice">{{ t("workMode.wakeLockFailed", { reason: wakeLockError }) }}</p>
    <p v-if="retryFailedError" class="notice">{{ retryFailedError }}</p>
    <p v-if="pool.lastError" class="notice">{{ pool.lastError }}</p>

    <label class="conc">
      {{ t("workMode.concurrency") }}
      <input
        type="range" min="1" max="8" step="1"
        :value="pool.maxConcurrent"
        @input="pool.setMaxConcurrent(Number(($event.target as HTMLInputElement).value))"
      />
      <span class="conc-value">{{ pool.maxConcurrent }}</span>
    </label>
  </div>
</template>

<style scoped>
.work-mode {
  max-width: 40rem;
  margin: 0 auto;
  padding: 2rem 1.25rem;
  font-variant-numeric: tabular-nums;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.title-row { display: flex; align-items: center; gap: 0.6rem; }
h1 { font-size: 1.1rem; font-weight: 600; margin: 0; }
.dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--color-text-secondary); }
.dot.online { background: #3fbf6f; }
.dot.connecting { background: #d8a13a; }
.dot.offline { background: var(--color-text-secondary); }
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 7.5rem;
  justify-content: center;
  padding: 0.6rem 1rem;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  border-radius: 999px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}
.toggle:hover:not(:disabled) { border-color: var(--color-accent-primary); }
.toggle.on { border-color: #3fbf6f; background: color-mix(in srgb, #3fbf6f 14%, var(--color-bg-secondary)); color: #3fbf6f; }
.toggle-indicator { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: currentColor; opacity: 0.5; }
.toggle.on .toggle-indicator { opacity: 1; box-shadow: 0 0 0 0.25rem color-mix(in srgb, #3fbf6f 20%, transparent); }
.toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.exit { border: 0; background: transparent; color: var(--color-text-secondary); cursor: pointer; font-size: 0.85rem; padding: 0.6rem 0.2rem; }
.exit:hover { color: var(--color-text-primary); }
.retry-failed { margin-left: 0.6rem; border: 1px solid var(--color-border-subtle); background: transparent; color: var(--color-accent-primary); border-radius: 0.3rem; padding: 0.15rem 0.4rem; cursor: pointer; font-size: 0.75rem; }
.retry-failed:disabled { opacity: 0.45; cursor: not-allowed; }

.intro { margin: 1.5rem 0 0.75rem; color: var(--color-text-secondary); line-height: 1.55; }
.task-options { display: grid; gap: 0.55rem; border: 1px solid var(--color-border-subtle); padding: 0.8rem; margin: 1rem 0; }
.task-options legend { color: var(--color-text-secondary); font-size: 0.82rem; padding: 0 0.35rem; }
.task-option { display: flex; align-items: center; gap: 0.55rem; font-size: 0.9rem; }
.task-option small { color: var(--color-text-secondary); margin-left: auto; }
.task-option.unavailable { opacity: 0.65; }
.lossless-dispatch { border: 1px solid var(--color-border-subtle); padding: 0.75rem; margin: 1rem 0; font-size: 0.85rem; }
.lossless-dispatch button { border: 1px solid var(--color-border-subtle); background: var(--color-bg-secondary); color: var(--color-text-primary); border-radius: 0.3rem; padding: 0.4rem 0.65rem; cursor: pointer; }
.lossless-dispatch button:disabled { opacity: 0.5; }
.gauge { margin: 1.75rem 0 1.5rem; }
.gauge-value { font-size: 3.5rem; line-height: 1; font-weight: 300; }
.of { font-size: 1.5rem; color: var(--color-text-secondary); }
.gauge-label { color: var(--color-text-secondary); font-size: 0.85rem; margin-top: 0.35rem; }
.bar { height: 3px; background: var(--color-bg-tertiary); margin-top: 0.9rem; }
.fill { height: 100%; background: #3fbf6f; transition: width 0.3s linear; }
.progress-counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--color-border); margin: -0.75rem 0 1.5rem; }
.progress-counts div { display: flex; flex-direction: column; gap: 0.2rem; padding: 0.55rem; background: var(--color-bg); }
.progress-counts span { color: var(--color-text-secondary); font-size: 0.72rem; }
.progress-counts b { font-size: 1rem; }

.slots { display: grid; gap: 1px; background: var(--color-border); border: 1px solid var(--color-border); }
.slot {
  background: var(--color-bg);
  padding: 0.55rem 0.75rem;
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  min-height: 1.2rem;
  font-size: 0.85rem;
}
.slot-type { color: var(--color-accent); flex-shrink: 0; }
.slot-name { color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot-idle { color: var(--color-text-secondary); opacity: 0.4; }

.meters { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.75rem; margin: 1.5rem 0; }
.meter { display: flex; flex-direction: column; gap: 0.15rem; }
.k { font-size: 0.75rem; color: var(--color-text-secondary); }
.v { font-size: 1rem; }

.notice { color: var(--color-text-secondary); font-size: 0.85rem; }
.wake-lock-note { margin: -0.8rem 0 1.5rem; color: var(--color-text-secondary); font-size: 0.8rem; line-height: 1.45; }
.conc { display: flex; align-items: center; gap: 0.75rem; font-size: 0.85rem; color: var(--color-text-secondary); }
.conc input { flex: 1; }
.conc-value { min-width: 1.2rem; text-align: right; color: var(--color-text); }
</style>
