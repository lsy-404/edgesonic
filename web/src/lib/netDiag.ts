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

// Network diagnostics for media transfers. Completed requests surface through
// PerformanceObserver; requests that hang never produce a timing entry, so an
// in-flight registry with a watchdog covers that blind spot. Verbose per-chunk
// logging is opt-in via localStorage "edgesonic:netdebug" = "1".

const TAG = "[NetDiag]";
const WATCHDOG_INTERVAL_MS = 10_000;
const SLOW_REQUEST_MS = 15_000;
const SNAPSHOT_KEY = "edgesonic:netdiag:last-pagehide";
const SNAPSHOT_LIMIT = 20;

const MEDIA_URL_PATTERNS = [
  "/rest/stream",
  "/rest/download",
  "/rest/getCoverArt",
  ".r2.cloudflarestorage.com",
];

export function isVerbose(): boolean {
  try {
    return localStorage.getItem("edgesonic:netdebug") === "1";
  } catch {
    return false;
  }
}

export interface InflightHandle {
  progress(receivedBytes: number): void;
  end(detail?: Record<string, unknown>): void;
  fail(reason: unknown): void;
}

export interface AudioRequestHandle {
  end(detail?: Record<string, unknown>): void;
  fail(reason: unknown): void;
}

interface InflightEntry {
  id: number;
  label: string;
  url: string;
  startedAt: number;
  bytes: number;
  lastProgressAt: number;
  warned: boolean;
  audio?: { bufferedSeconds: number; networkState: number; readyState: number; paused: boolean };
}

let nextId = 1;
const inflight = new Map<number, InflightEntry>();
const audioRequests = new WeakMap<HTMLAudioElement, AudioRequestHandle>();
let initialized = false;

function shortUrl(url: string): string {
  try {
    const u = new URL(url, globalThis.location?.href);
    const id = u.searchParams.get("id");
    return `${u.host}${u.pathname}${id ? `?id=${id}` : ""}`;
  } catch {
    return "(invalid URL)";
  }
}

function safeReason(reason: unknown): string {
  if (reason instanceof DOMException || reason instanceof Error) return reason.name;
  return typeof reason === "string" ? reason.slice(0, 80).replace(/https?:\/\/\S+/g, "(URL)") : "request failed";
}

function throughput(entry: InflightEntry): string {
  const secs = (performance.now() - entry.startedAt) / 1000;
  if (secs <= 0 || entry.bytes <= 0) return "0 KB/s";
  return `${Math.round(entry.bytes / 1024 / secs)} KB/s`;
}

/** Register a media transfer; call progress/end/fail on the returned handle. */
export function beginRequest(label: string, url: string): InflightHandle {
  const entry: InflightEntry = {
    id: nextId++,
    label,
    url,
    startedAt: performance.now(),
    bytes: 0,
    lastProgressAt: performance.now(),
    warned: false,
  };
  inflight.set(entry.id, entry);
  console.info(`${TAG} start #${entry.id} ${label}`, shortUrl(url));
  return {
    progress(receivedBytes: number) {
      entry.bytes = receivedBytes;
      entry.lastProgressAt = performance.now();
      if (isVerbose()) {
        console.debug(`${TAG} progress #${entry.id} ${label}: ${receivedBytes} B, ${throughput(entry)}`);
      }
    },
    end(detail?: Record<string, unknown>) {
      inflight.delete(entry.id);
      const ms = Math.round(performance.now() - entry.startedAt);
      console.info(`${TAG} done #${entry.id} ${label}: ${entry.bytes} B in ${ms} ms (${throughput(entry)})`, detail ?? "");
    },
    fail(reason: unknown) {
      inflight.delete(entry.id);
      const ms = Math.round(performance.now() - entry.startedAt);
      console.warn(`${TAG} fail #${entry.id} ${label} after ${ms} ms, ${entry.bytes} B received:`, safeReason(reason));
    },
  };
}

function bufferedSeconds(el: HTMLAudioElement): number {
  let total = 0;
  try {
    for (let i = 0; i < el.buffered.length; i++) total += el.buffered.end(i) - el.buffered.start(i);
  } catch { /* media is not ready */ }
  return Math.round(total * 10) / 10;
}

/** Register a browser-owned audio request without inventing byte counts. */
export function beginAudioRequest(el: HTMLAudioElement, label: string, url: string): AudioRequestHandle {
  endAudioRequest(el, "source replaced");
  const request = beginRequest(label, url);
  const entry = inflight.get(nextId - 1);
  let finished = false;
  const update = () => {
    if (!entry || finished) return;
    const buffered = bufferedSeconds(el);
    if (!entry.audio || buffered > entry.audio.bufferedSeconds) entry.lastProgressAt = performance.now();
    entry.audio = {
      bufferedSeconds: buffered,
      networkState: el.networkState,
      readyState: el.readyState,
      paused: el.paused,
    };
  };
  const cleanup = () => {
    el.removeEventListener("progress", update);
    el.removeEventListener("loadedmetadata", update);
    el.removeEventListener("canplay", update);
    el.removeEventListener("error", onError);
    el.removeEventListener("emptied", onEmptied);
    el.removeEventListener("suspend", onSuspend);
  };
  const finish = (kind: "end" | "fail", detail?: Record<string, unknown> | unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (kind === "end") request.end({ audio: entry?.audio, ...(detail as Record<string, unknown> | undefined) });
    else request.fail(detail);
  };
  const onError = () => finish("fail", el.error?.message || "audio error");
  const onEmptied = () => finish("end", { reason: "source cleared" });
  const onSuspend = () => finish("end", { reason: "native transfer suspended" });
  el.addEventListener("progress", update);
  el.addEventListener("loadedmetadata", update);
  el.addEventListener("canplay", update);
  el.addEventListener("error", onError);
  el.addEventListener("emptied", onEmptied);
  el.addEventListener("suspend", onSuspend);
  const handle: AudioRequestHandle = {
    end(detail) { finish("end", detail); },
    fail(reason) { finish("fail", reason); },
  };
  audioRequests.set(el, handle);
  return handle;
}

/** End the recorded native request when the player unloads its source. */
export function endAudioRequest(el: HTMLAudioElement, reason = "source cleared"): void {
  const request = audioRequests.get(el);
  if (!request) return;
  request.end({ reason });
  audioRequests.delete(el);
}

function watchdogTick(): void {
  const now = performance.now();
  for (const entry of inflight.values()) {
    const age = now - entry.startedAt;
    const sinceProgress = now - entry.lastProgressAt;
    if (age < SLOW_REQUEST_MS) continue;
    // Re-warn only when the transfer is also stalled, not merely long-lived.
    if (entry.warned && sinceProgress < SLOW_REQUEST_MS) continue;
    entry.warned = true;
    console.warn(
      `${TAG} in-flight #${entry.id} ${entry.label}: ${Math.round(age / 1000)}s elapsed, ` +
      `${entry.bytes} B (${throughput(entry)}), ${Math.round(sinceProgress / 1000)}s since last data`,
      shortUrl(entry.url), entry.audio ? { audio: entry.audio } : "",
    );
  }
}

/** Snapshot of an <audio> element for stall/error logs. */
export function describeAudio(el: HTMLAudioElement): Record<string, unknown> {
  const buffered: [number, number][] = [];
  try {
    for (let i = 0; i < el.buffered.length; i++) {
      buffered.push([
        Math.round(el.buffered.start(i) * 10) / 10,
        Math.round(el.buffered.end(i) * 10) / 10,
      ]);
    }
  } catch { /* not ready */ }
  const src = el.currentSrc || el.src || "";
  return {
    srcKind: src.startsWith("blob:") ? "blob" : src ? "network" : "none",
    src: src.startsWith("blob:") ? "blob" : shortUrl(src),
    // 0 EMPTY / 1 IDLE / 2 LOADING / 3 NO_SOURCE
    networkState: el.networkState,
    // 0 NOTHING .. 4 ENOUGH_DATA
    readyState: el.readyState,
    currentTime: Math.round(el.currentTime * 10) / 10,
    duration: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : el.duration,
    paused: el.paused,
    buffered,
  };
}

function resourceKind(name: string): "media" | "api" | "resource" {
  if (MEDIA_URL_PATTERNS.some((p) => name.includes(p))) return "media";
  if (name.includes("/rest/") || name.includes("/edgesonic/")) return "api";
  return "resource";
}

function observeResourceTimings(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        const kind = resourceKind(e.name);
        if (kind === "resource") continue;
        // Cross-origin entries without Timing-Allow-Origin zero out most
        // fields; duration and nextHopProtocol (when present) still help.
        console.info(`${TAG} ${kind} timing ${shortUrl(e.name)}:`, {
          protocol: e.nextHopProtocol || "(hidden)",
          durationMs: Math.round(e.duration),
          ttfbMs: e.responseStart > 0 ? Math.round(e.responseStart - e.startTime) : null,
          transferSize: e.transferSize || null,
          decodedBodySize: e.decodedBodySize || null,
          initiator: e.initiatorType,
        });
      }
    });
    observer.observe({ type: "resource", buffered: false });
  } catch (err) {
    console.warn(`${TAG} resource observer unavailable:`, err);
  }
}

function observeNavigationTimings(): void {
  const report = (entry: PerformanceNavigationTiming) => {
    console.info(`${TAG} navigation timing:`, {
      durationMs: Math.round(entry.duration),
      ttfbMs: entry.responseStart > 0 ? Math.round(entry.responseStart - entry.startTime) : null,
      domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd - entry.startTime),
      loadMs: Math.round(entry.loadEventEnd - entry.startTime),
      transferSize: entry.transferSize || null,
      type: entry.type,
    });
  };
  for (const entry of performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]) report(entry);
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceNavigationTiming[]) report(entry);
    });
    observer.observe({ type: "navigation", buffered: true });
  } catch { /* navigation observer is optional */ }
}

function snapshotInflight(): Array<Record<string, unknown>> {
  return Array.from(inflight.values()).slice(0, SNAPSHOT_LIMIT).map((entry) => ({
    id: entry.id,
    label: entry.label,
    url: shortUrl(entry.url),
    elapsedMs: Math.round(performance.now() - entry.startedAt),
    bytes: entry.bytes,
    audio: entry.audio,
  }));
}

function savePagehideSnapshot(): void {
  const snapshot = snapshotInflight();
  if (!snapshot.length) return;
  console.warn(`${TAG} pagehide with in-flight requests:`, snapshot);
  try { sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch { /* storage unavailable */ }
}

export function initNetDiag(): void {
  if (initialized) return;
  initialized = true;
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; saveData?: boolean; downlink?: number };
  };
  console.info(`${TAG} init`, {
    verbose: isVerbose(),
    connection: nav.connection
      ? {
          effectiveType: nav.connection.effectiveType,
          saveData: nav.connection.saveData,
          downlinkMbps: nav.connection.downlink,
        }
      : "(unavailable)",
    swController: navigator.serviceWorker?.controller?.scriptURL || "(none)",
  });
  navigator.serviceWorker?.addEventListener?.("controllerchange", () => {
    console.info(`${TAG} SW controller changed:`, navigator.serviceWorker.controller?.scriptURL || "(none)");
  });
  observeResourceTimings();
  observeNavigationTimings();
  window.addEventListener("pagehide", savePagehideSnapshot, { once: false });
  setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  (window as unknown as Record<string, unknown>).__esNetDiag = {
    inflight: () =>
      snapshotInflight().map((e) => ({ ...e, throughput: typeof e.bytes === "number" ? `${Math.round(e.bytes / 1024)} KB` : "0 KB" })),
  };
}
