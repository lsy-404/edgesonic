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

// The work pool. A browser joins by holding a socket here; the coordinator
// claims queued rows and pushes them down it.
//
// The socket carries dispatch only. Results still go back over
// POST /work/submit through the shared runner, so this store never duplicates
// the submit/apply/retry logic — it is a connection plus a concurrency budget.
//
// Participation is now scoped to the dedicated work-mode page rather than
// every open tab. That is what lets this store be as blunt as it is: there is
// no playback to yield to and no user typing into the page, so none of the
// throttling and reference-counted pausing the old ambient pool needed
// exists here. A machine on this page is a worker.

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useAuth } from "../api";
import { runTask, fileNameFrom, type QueuedTask } from "../lib/taskRunner";

const STORAGE_KEY = "participate_work";
const STORAGE_KEY_CONCURRENCY = "edgesonic:worker_max_concurrent";

// Reconnect backoff. Starts fast so a dropped socket recovers without the
// operator noticing, then backs off to avoid hammering a server that is down.
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Keepalive. The coordinator answers these without waking from hibernation;
// a missed reply is what tells us the connection died silently (a sleeping
// laptop's socket can stay "open" locally long after the server dropped it).
const PING_INTERVAL_MS = 25_000;
const PONG_GRACE_MS = 10_000;

// "refused" is a policy answer, not a transport failure: the pool is switched
// off or the coordinator isn't configured. Reconnecting on a loop would just
// generate load, so it is a terminal state until the operator retries.
export type LinkState = "offline" | "connecting" | "online" | "refused";

/**
 * AIMD step. Given how the last task went, returns the concurrency budget to
 * advertise next:
 *   - it failed → halve (min 1); back off the moment the device or network
 *     shows strain.
 *   - it succeeded → +1, capped at `ceiling`; ramp one step at a time.
 * Exported so the unit test can exercise the curve without a socket.
 */
export function nextConcurrency(
  current: number,
  ceiling: number,
  batch: { total: number; failed: number },
): number {
  if (batch.total === 0) return current;
  if (batch.failed > 0) return Math.max(1, Math.floor(current / 2));
  return Math.min(ceiling, current + 1);
}

interface RecentTask {
  id: string;
  taskType: string;
  fileName: string;
  status: "ok" | "fail";
  finishedAt: number;
  error?: string;
}

export const useWorkSocket = defineStore("workSocket", () => {
  const { hasPerm, edgesonicFetch, edgesonicPost, restUrl } = useAuth();

  const linkState = ref<LinkState>("offline");
  const lastError = ref<string | null>(null);
  const connectedAt = ref<number>(0);
  const reconnects = ref(0);
  const stats = ref({ completed: 0, failed: 0 });
  const running = ref<Map<string, { taskType: string; fileName: string; startedAt: number }>>(new Map());
  const recent = ref<RecentTask[]>([]);
  // Opt-in, persisted: a work-mode machine that reloads or crashes comes back
  // working instead of sitting idle waiting for somebody to click Start.
  const enabled = ref(localStorage.getItem(STORAGE_KEY) === "true");
  // Ceiling (per-browser, from the settings slider). `currentConcurrency` is
  // the adaptive value actually advertised to the coordinator.
  const maxConcurrent = ref(
    parseInt(localStorage.getItem(STORAGE_KEY_CONCURRENCY) || "0", 10) || 3,
  );
  const currentConcurrency = ref(1);

  const eligible = computed(() => hasPerm("participate_work"));
  const inFlight = computed(() => running.value.size);
  const utilisation = computed(() =>
    currentConcurrency.value === 0
      ? 0
      : Math.min(1, running.value.size / currentConcurrency.value),
  );

  // Throughput over a trailing window. Transport-agnostic — it needs only the
  // completion count and wall clock — and it is the readout that separates
  // "working slowly" from "connected but never dispatched to".
  const SPEED_WINDOW_MS = 5 * 60 * 1000;
  const SAMPLE_LIMIT = 120;
  const completedSamples = ref<Array<{ ts: number; count: number }>>([]);
  function recordSample(): void {
    completedSamples.value.push({ ts: Date.now(), count: stats.value.completed });
    if (completedSamples.value.length > SAMPLE_LIMIT) {
      completedSamples.value.splice(0, completedSamples.value.length - SAMPLE_LIMIT);
    }
  }
  const speedPerMin = computed<number | null>(() => {
    const samples = completedSamples.value;
    if (samples.length < 2) return null;
    const now = Date.now();
    const cutoff = now - SPEED_WINDOW_MS;
    // Oldest sample inside the window, or the first one — a low-throughput
    // pool can have samples spread further apart than the window.
    let oldest = samples[0];
    for (const s of samples) {
      if (s.ts >= cutoff) { oldest = s; break; }
    }
    const elapsed = now - oldest.ts;
    if (elapsed < 1000) return null;
    const delta = stats.value.completed - oldest.count;
    if (delta <= 0) return 0;
    return Math.round((delta * 60_000) / elapsed * 10) / 10;
  });

  const isWorking = computed(() =>
    running.value.size > 0 || linkState.value === "connecting",
  );

  let socket: WebSocket | null = null;
  let backoff = BACKOFF_MIN_MS;
  let reconnectTimer: number | null = null;
  let pingTimer: number | null = null;
  let pongTimer: number | null = null;
  let abort: AbortController | null = null;
  // Set once the operator turns the page on; every reconnect path checks it so
  // a socket that drops after they turned it off doesn't come back.
  let wanted = false;

  const RECENT_LIMIT = 8;
  function pushRecent(entry: RecentTask): void {
    recent.value.unshift(entry);
    if (recent.value.length > RECENT_LIMIT) recent.value.length = RECENT_LIMIT;
  }

  // What this browser can actually execute — the server filters dispatch on it.
  // ffmpeg.wasm needs SharedArrayBuffer, which needs the page to be
  // cross-origin isolated; we check both the symbol (engine support) and the
  // runtime flag (page actually isolated). A computed rather than a function
  // so the settings UI can bind to it.
  const caps = computed<string[]>(() => {
    const c = ["music-metadata", "scrape"];
    if (
      typeof SharedArrayBuffer !== "undefined" &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
    ) {
      c.push("ffmpeg");
    }
    return c;
  });

  function socketUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      caps: caps.value.join(","),
      concurrency: String(currentConcurrency.value),
    });
    return `${proto}//${location.host}/edgesonic/work/socket?${params}`;
  }

  // Distinguishing "the server said no" from "the connection dropped" before
  // opening the socket: a WebSocket handshake reports both as a bare close
  // event with no status, so ask over plain HTTP first. Without this, a pool
  // switched off by an admin puts every work-mode tab into a permanent
  // 30-second reconnect loop against an endpoint that will keep refusing.
  async function refusedReason(): Promise<string | null> {
    try {
      const res = await fetch("/edgesonic/work/socket", { credentials: "same-origin" });
      if (res.status !== 503) return null;
      const body = await res.json().catch(() => ({})) as { error?: string };
      return body.error || "Worker pool is unavailable";
    } catch {
      // Network failure is not a refusal — let the socket attempt proceed and
      // the normal backoff handle it.
      return null;
    }
  }

  async function connect(): Promise<void> {
    if (!wanted || !eligible.value) return;
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    linkState.value = "connecting";
    abort = new AbortController();

    const refused = await refusedReason();
    if (refused) {
      linkState.value = "refused";
      lastError.value = refused;
      return;                    // deliberately no reconnect
    }
    if (!wanted) return;         // stopped while we were asking

    let ws: WebSocket;
    try { ws = new WebSocket(socketUrl()); }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e);
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      linkState.value = "online";
      lastError.value = null;
      connectedAt.value = Date.now();
      backoff = BACKOFF_MIN_MS;
      startKeepalive();
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      // The coordinator's keepalive reply, answered by the runtime itself.
      if (ev.data === "pong") { clearPongTimer(); return; }
      let msg: { type?: string; task?: QueuedTask };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "task" && msg.task) void execute(msg.task);
    });

    ws.addEventListener("close", () => {
      stopKeepalive();
      socket = null;
      if (linkState.value === "online") reconnects.value++;
      linkState.value = "offline";
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      lastError.value = "socket error";
      // 'close' always follows; reconnection is scheduled there so we don't
      // arm two timers for one failure.
    });
  }

  async function execute(task: QueuedTask): Promise<void> {
    // Backstop against over-subscription: the coordinator tracks our budget,
    // but a config frame in flight or a stale attachment could put one task
    // too many on the wire. Hand it straight back rather than running it.
    if (running.value.size >= currentConcurrency.value) {
      send({ type: "done", id: task.id });
      return;
    }
    const fileName = fileNameFrom(task);
    running.value.set(task.id, { taskType: task.taskType, fileName, startedAt: Date.now() });
    // Reassign so Vue sees the mutation — a Map's own mutations aren't tracked.
    running.value = new Map(running.value);
    const signal = abort?.signal ?? new AbortController().signal;
    const outcome = await runTask(task, { restUrl, edgesonicPost }, signal);
    running.value.delete(task.id);
    running.value = new Map(running.value);

    if (outcome.status === "ok") {
      stats.value.completed++;
      pushRecent({ id: task.id, taskType: task.taskType, fileName, status: "ok", finishedAt: Date.now() });
      recordSample();
    } else if (outcome.status === "failed") {
      stats.value.failed++;
      pushRecent({ id: task.id, taskType: task.taskType, fileName, status: "fail", finishedAt: Date.now(), error: outcome.error });
      recordSample();
    }

    // Adapt the budget to what this device actually managed. An abandoned
    // task says nothing about capacity, so it doesn't feed the controller.
    if (outcome.status !== "aborted") {
      const next = nextConcurrency(currentConcurrency.value, maxConcurrent.value, {
        total: 1,
        failed: outcome.status === "failed" ? 1 : 0,
      });
      if (next !== currentConcurrency.value) {
        currentConcurrency.value = next;
        send({ type: "config", caps: caps.value, maxConcurrent: next });
      }
    }

    // Hand the slot back even when the task was aborted — the server needs to
    // know this browser is free again, and the abandoned row recovers through
    // the disconnect release or the reclaim sweep.
    send({ type: "done", id: task.id });
  }

  function send(msg: unknown): void {
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify(msg)); } catch { /* closing */ }
    }
  }

  // --- keepalive ------------------------------------------------------------

  function startKeepalive(): void {
    stopKeepalive();
    pingTimer = window.setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      try { socket.send("ping"); } catch { return; }
      // A reply must land inside the grace window. Silence means the socket is
      // open locally but dead in transit — close it so the reconnect path runs.
      if (pongTimer === null) {
        pongTimer = window.setTimeout(() => {
          pongTimer = null;
          lastError.value = "keepalive timed out";
          try { socket?.close(); } catch { /* already closing */ }
        }, PONG_GRACE_MS);
      }
    }, PING_INTERVAL_MS);
  }

  function clearPongTimer(): void {
    if (pongTimer !== null) { window.clearTimeout(pongTimer); pongTimer = null; }
  }

  function stopKeepalive(): void {
    if (pingTimer !== null) { window.clearInterval(pingTimer); pingTimer = null; }
    clearPongTimer();
  }

  function scheduleReconnect(): void {
    if (!wanted) return;
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff);
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
  }

  // --- lifecycle ------------------------------------------------------------

  function start(): void {
    wanted = true;
    backoff = BACKOFF_MIN_MS;
    void connect();
  }

  function stop(): void {
    wanted = false;
    if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopKeepalive();
    // Abandon in-flight tasks rather than waiting them out. Closing the socket
    // makes the coordinator release their rows immediately.
    abort?.abort();
    abort = null;
    try { socket?.close(); } catch { /* already closing */ }
    socket = null;
    linkState.value = "offline";
    running.value = new Map();
  }

  // The opt-in itself. Persisted so the machine resumes on reload.
  function setEnabled(v: boolean): void {
    enabled.value = v;
    localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
    if (v) start(); else stop();
  }

  // "Prove the queue is alive." Reconnects when offline — including after a
  // refusal, which is how an operator retries once they've switched the pool
  // back on — and otherwise re-announces the budget, which makes the
  // coordinator re-run dispatch.
  function nudge(): void {
    if (linkState.value === "online") {
      send({ type: "config", caps: caps.value, maxConcurrent: currentConcurrency.value });
      return;
    }
    backoff = BACKOFF_MIN_MS;
    start();
  }

  function setMaxConcurrent(n: number): void {
    const mc = Math.max(1, Math.min(8, Math.floor(Number(n) || 0)));
    maxConcurrent.value = mc;
    localStorage.setItem(STORAGE_KEY_CONCURRENCY, String(mc));
    // The adaptive value can't exceed a ceiling that just came down.
    if (currentConcurrency.value > mc) currentConcurrency.value = mc;
    send({ type: "config", caps: caps.value, maxConcurrent: currentConcurrency.value });
  }

  // Pull the admin's global default for the concurrency ceiling. A value saved
  // in this browser always wins — the slider is a per-machine setting, and the
  // server value is only the seed for a browser that has never set one.
  async function hydrateConfig(): Promise<void> {
    try {
      const text = await edgesonicFetch("features/list");
      const data = JSON.parse(text);
      if (!data.ok) return;
      const fs: Array<{ key: string; value: string }> = data.featureStrings || [];
      const local = parseInt(localStorage.getItem(STORAGE_KEY_CONCURRENCY) || "0", 10);
      if (Number.isFinite(local) && local >= 1 && local <= 8) return;
      const server = parseInt(fs.find((f) => f.key === "worker_max_concurrent")?.value || "3", 10);
      if (Number.isFinite(server) && server >= 1 && server <= 8) {
        maxConcurrent.value = server;
        if (currentConcurrency.value > server) currentConcurrency.value = server;
      }
    } catch { /* fail quiet — the built-in default stands */ }
  }

  function reset(): void {
    stop();
    stats.value = { completed: 0, failed: 0 };
    lastError.value = null;
    recent.value = [];
    completedSamples.value = [];
    reconnects.value = 0;
    // Start the next session's ramp from scratch rather than carrying over a
    // value tuned for whatever this one was doing.
    currentConcurrency.value = 1;
  }

  return {
    linkState, lastError, connectedAt, reconnects,
    stats, running, recent, enabled,
    maxConcurrent, currentConcurrency,
    eligible, inFlight, utilisation, isWorking, speedPerMin, caps,
    start, stop, setEnabled, nudge, setMaxConcurrent, hydrateConfig, reset,
  };
});
