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
import { useWorkSocket } from "../stores/workSocket";

const { t } = useI18n();
const pool = useWorkSocket();

// The opt-in lives in the store (and localStorage), not here: a work machine
// that reloads should come back working, and the toggle must never disagree
// with whether the socket is actually up.
const active = computed(() => pool.enabled);
// Screen Wake Lock keeps the display (and with it the tab's full timer and
// rendering budget) awake. It needs a secure context and is refused without a
// user gesture, so we only ask on the toggle and re-ask when the page comes
// back to the foreground — the browser releases the lock on every hide.
const wakeLock = ref<WakeLockSentinel | null>(null);
const wakeLockError = ref<string | null>(null);
const wakeLockSupported = typeof navigator !== "undefined" && "wakeLock" in navigator;

const now = ref(Date.now());
let tick: number | null = null;

const uptime = computed(() => {
  if (pool.linkState !== "online" || !pool.connectedAt) return "--";
  const s = Math.max(0, Math.floor((now.value - pool.connectedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
});

// Sized by the live adaptive budget, not the ceiling: showing eight empty
// slots while the controller has backed off to two would misreport the machine
// as idle when it is actually saturated.
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

// The lock dies whenever the page is hidden; take it back on return so a tab
// that was briefly switched away from doesn't quietly stop holding the screen.
function onVisibility(): void {
  if (!document.hidden && active.value && !wakeLock.value) void requestWakeLock();
}

onMounted(async () => {
  tick = window.setInterval(() => { now.value = Date.now(); }, 1000);
  document.addEventListener("visibilitychange", onVisibility);
  await pool.hydrateConfig();
  // Resume a machine that was already opted in before this page loaded.
  if (pool.enabled) {
    pool.start();
    await requestWakeLock();
  }
});

onBeforeUnmount(() => {
  if (tick !== null) window.clearInterval(tick);
  document.removeEventListener("visibilitychange", onVisibility);
  // Deliberately does NOT stop the pool. The store is a singleton shared with
  // the rest of the app, and the opt-in is persisted — navigating away from
  // this page is not the same as switching the machine off, which is what the
  // toggle is for. Only the screen lock is page-scoped.
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
      <button class="toggle" :class="{ on: active }" :disabled="!pool.eligible" @click="toggle">
        {{ active ? t("workMode.stop") : t("workMode.start") }}
      </button>
    </header>

    <p v-if="!pool.eligible" class="notice">{{ t("workMode.ineligible") }}</p>

    <section class="gauge">
      <div class="gauge-value">{{ pool.inFlight }}<span class="of">/{{ pool.currentConcurrency }}</span></div>
      <div class="gauge-label">{{ t("workMode.occupied") }}</div>
      <div class="bar"><div class="fill" :style="{ width: `${pool.utilisation * 100}%` }"></div></div>
    </section>

    <section class="slots">
      <div v-for="(slot, i) in slots" :key="i" class="slot" :class="{ busy: !!slot }">
        <template v-if="slot">
          <span class="slot-type">{{ slot.taskType }}</span>
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

    <p v-if="wakeLockError" class="notice">{{ t("workMode.wakeLockFailed", { reason: wakeLockError }) }}</p>
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
/* Deliberately flat: no gradients, blurs, shadows or transitions beyond the
   occupancy bar. Every pixel this page paints is CPU taken from the tasks. */
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
  padding: 0.45rem 1.1rem;
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  border-radius: 4px;
  cursor: pointer;
}
.toggle.on { border-color: #3fbf6f; color: #3fbf6f; }
.toggle:disabled { opacity: 0.5; cursor: not-allowed; }

.gauge { margin: 2rem 0 1.5rem; }
.gauge-value { font-size: 3.5rem; line-height: 1; font-weight: 300; }
.of { font-size: 1.5rem; color: var(--color-text-secondary); }
.gauge-label { color: var(--color-text-secondary); font-size: 0.85rem; margin-top: 0.35rem; }
.bar { height: 3px; background: var(--color-bg-tertiary); margin-top: 0.9rem; }
.fill { height: 100%; background: #3fbf6f; transition: width 0.3s linear; }

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
.conc { display: flex; align-items: center; gap: 0.75rem; font-size: 0.85rem; color: var(--color-text-secondary); }
.conc input { flex: 1; }
.conc-value { min-width: 1.2rem; text-align: right; color: var(--color-text); }
</style>
