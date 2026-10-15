<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Hls from "hls.js";
import { captionTrackUrl, mediaManifestUrl, type MediaSession } from "../lib/videoApi";

interface OverlayComment { id: string; text: string; displayName?: string; time?: number }
const props = withDefaults(defineProps<{
  session: MediaSession;
  audioOnly?: boolean;
  muted?: boolean;
  syncTime?: number;
  syncPlaying?: boolean;
  initialTime?: number;
  startPlaying?: boolean;
  controlsVisible?: boolean;
  comments?: OverlayComment[];
}>(), { audioOnly: false, muted: false, syncTime: undefined, syncPlaying: undefined, initialTime: 0, startPlaying: false, controlsVisible: true, comments: () => [] });
const { t } = useI18n();
const emit = defineEmits<{
  time: [value: number]; duration: [value: number]; playing: [value: boolean]; ended: []; error: [message: string]; autoplayBlocked: [];
}>();
const media = ref<HTMLVideoElement | null>(null);
const hlsError = ref("");
const danmaku = ref<Array<{ time: number; text: string }>>([]);
const currentTime = ref(0);
const selectedCaption = ref("");
let hls: Hls | null = null;
let hlsGeneration = 0;
let activeSessionId = "";
let resumeAfterReload = false;
let resumeTime = 0;
let danmakuController: AbortController | null = null;
let danmakuRequestId = 0;
let danmakuSessionId = "";
let lastHeartbeatAt = 0;
const captionOptions = computed(() => props.session.captions ?? []);
const embeddedUrl = computed(() => {
  if (props.session.transport !== "iframe" || !props.session.sourceUrl) return "";
  const url = new URL(props.session.sourceUrl);
  url.searchParams.set(props.session.provider === "bilibili" ? "muted" : "mute", props.muted ? "1" : "0");
  return url.href;
});
const activeDanmaku = computed(() => danmaku.value.filter((entry) => Math.abs(entry.time - currentTime.value) < 4).slice(-5));
const danmakuState = ref<"loading" | "available" | "empty" | "failed">("loading");

function releaseSession(session: MediaSession) {
  if (session.transport !== "hls") return;
  void fetch(`/edgesonic/media/${encodeURIComponent(session.id)}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => {});
}
function onPageHide(event: PageTransitionEvent) { if (!event.persisted) releaseSession(props.session); }
window.addEventListener("pagehide", onPageHide);

function releaseHls() {
  hlsGeneration++;
  hls?.destroy();
  hls = null;
  if (media.value) {
    media.value.pause();
    media.value.removeAttribute("src");
    media.value.load();
  }
}

function loadDanmaku(session: MediaSession) {
  if (session.transport !== "hls") {
    danmakuController?.abort();
    danmakuRequestId++;
    danmaku.value = [];
    danmakuState.value = "empty";
    return;
  }
  if (danmakuSessionId === session.id) return;
  danmakuController?.abort();
  danmakuController = new AbortController();
  const requestId = ++danmakuRequestId;
  danmakuSessionId = session.id;
  danmaku.value = [];
  danmakuState.value = "loading";
  void fetch(`/edgesonic/media/${encodeURIComponent(session.id)}/danmaku`, { credentials: "same-origin", signal: danmakuController.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error("Danmaku request failed");
      return response.text();
    })
    .then((xml) => {
      if (requestId !== danmakuRequestId || props.session.id !== session.id) return;
      if (!xml) { danmakuState.value = "empty"; return; }
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      danmaku.value = Array.from(doc.querySelectorAll("d[p]"), (node) => {
        const attrs = node.getAttribute("p")?.split(",") ?? [];
        return { time: Number(attrs[0]) || 0, text: node.textContent ?? "" };
      }).filter((entry) => entry.text);
      danmakuState.value = danmaku.value.length ? "available" : "empty";
    }).catch((error: unknown) => {
      if (requestId !== danmakuRequestId || props.session.id !== session.id || (error as { name?: string })?.name === "AbortError") return;
      danmaku.value = [];
      danmakuState.value = "failed";
    });
}

watch(() => props.session, (next, previous) => {
  if (previous && previous.id !== next.id) releaseSession(previous);
});

watch([media, () => props.session.id, () => props.audioOnly], async ([element, sessionId, audioOnly]) => {
  if (!element || !sessionId) { releaseHls(); return; }
  resumeAfterReload = sessionId === activeSessionId ? !element.paused : props.startPlaying;
  resumeTime = sessionId === activeSessionId ? element.currentTime : props.initialTime;
  activeSessionId = sessionId;
  releaseHls();
  const generation = hlsGeneration;
  hlsError.value = "";
  currentTime.value = resumeTime;
  element.muted = props.muted;
  if (audioOnly && !props.session.audioTracks.length) {
    hlsError.value = t("media.audioTrackUnavailable");
    emit("error", hlsError.value);
    return;
  }
  const url = mediaManifestUrl(sessionId, audioOnly);
  const nativeHls = element.canPlayType("application/vnd.apple.mpegurl") !== "";
  if (props.session.transport === "file") {
    element.src = props.session.sourceUrl || "";
  } else if (Hls.isSupported()) {
    const instance = new Hls({ startPosition: Math.max(0, resumeTime) });
    hls = instance;
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal && generation === hlsGeneration) hlsError.value = "This stream could not be played in this browser.";
    });
    instance.attachMedia(element);
    instance.loadSource(url);
  } else if (nativeHls) {
    element.src = url;
  } else {
    hlsError.value = "This browser does not support HLS playback.";
    emit("error", hlsError.value);
  }
  loadDanmaku(props.session);
  if (captionOptions.value.length) selectedCaption.value = captionOptions.value[0].id;
}, { immediate: true, flush: "post" });

watch(() => props.muted, (muted) => { if (media.value) media.value.muted = muted; });
watch(() => [props.syncTime, props.syncPlaying] as const, async ([time, playing]) => {
  const element = media.value;
  if (!element || props.syncTime === undefined) return;
  if (typeof time === "number" && time < 0) {
    element.pause();
    if (element.readyState) element.currentTime = 0;
    return;
  }
  if (typeof time === "number" && Number.isFinite(time) && Math.abs(element.currentTime - time) > 0.65) {
    try { element.currentTime = Math.max(0, time); } catch { /* metadata is not ready */ }
  }
  if (playing === true && element.paused) {
    try { await element.play(); } catch { emit("autoplayBlocked"); }
  } else if (playing === false && !element.paused) element.pause();
}, { immediate: true });

watch(selectedCaption, (trackId) => {
  if (!media.value) return;
  for (const track of Array.from(media.value.textTracks)) track.mode = "disabled";
  if (!trackId) return;
  const index = captionOptions.value.findIndex((track) => track.id === trackId);
  const track = media.value.textTracks[index];
  if (track) track.mode = "showing";
});

watch(currentTime, (time) => emit("time", time));
function onTime() {
  const element = media.value;
  if (element?.readyState && resumeTime <= 0) currentTime.value = element.currentTime;
  // Buffered playback can outlast the container's idle timeout without requesting segments.
  if (element && !element.paused && !element.ended && props.session.transport === "hls" && Date.now() - lastHeartbeatAt >= 120_000) {
    lastHeartbeatAt = Date.now();
    void fetch(mediaManifestUrl(props.session.id, props.audioOnly), {
      method: "HEAD", credentials: "same-origin", signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  }
}
function onDuration() { const duration = media.value?.duration; if (duration && Number.isFinite(duration)) emit("duration", duration); void restoreInitialTime(); }
function onMetadata() { onDuration(); }
async function restoreInitialTime() {
  if (!media.value) return;
  if (resumeTime > 0) {
    if (!Number.isFinite(media.value.duration) || media.value.duration < resumeTime) return;
    try { media.value.currentTime = resumeTime; resumeTime = 0; } catch { return; }
  }
  const shouldResume = resumeAfterReload || (props.syncPlaying === true && (props.syncTime ?? 0) >= 0);
  resumeAfterReload = false;
  if (shouldResume) {
    try { await media.value.play(); } catch { emit("autoplayBlocked"); }
  }
}
function onEnded() { emit("ended"); }
function onPlay() { emit("playing", true); }
function onPause() { emit("playing", false); }
function onError() { if (!hlsError.value) hlsError.value = "The media session could not be loaded."; emit("error", hlsError.value); }
async function togglePlayback(): Promise<void> {
  if (!media.value) return;
  if (media.value.paused) {
    try { await media.value.play(); } catch { emit("autoplayBlocked"); }
  } else media.value.pause();
}
function seekTo(seconds: number): void {
  if (!media.value || !Number.isFinite(seconds)) return;
  media.value.currentTime = Math.max(0, Math.min(seconds, Number.isFinite(media.value.duration) ? media.value.duration : seconds));
}
function getPosition(): number { return media.value?.currentTime ?? 0; }
defineExpose({ togglePlayback, seekTo, getPosition });
onBeforeUnmount(() => { window.removeEventListener("pagehide", onPageHide); danmakuController?.abort(); danmakuRequestId++; releaseHls(); releaseSession(props.session); });
</script>

<template>
  <div class="media-surface" :class="{ 'audio-only': audioOnly }">
    <iframe v-if="session.transport === 'iframe'" :key="session.id" :src="embeddedUrl" :title="session.title" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" />
    <video v-else
      ref="media"
      :muted="muted"
      :controls="controlsVisible && syncTime === undefined"
      playsinline
      preload="metadata"
      @timeupdate="onTime"
      @loadedmetadata="onMetadata"
      @durationchange="onDuration"
      @ended="onEnded"
      @play="onPlay"
      @pause="onPause"
      @error="onError"
    >
      <track v-for="track in captionOptions" :key="track.id" :kind="'captions'" :label="track.title || track.language || track.id" :srclang="track.language || 'und'" :src="captionTrackUrl(session.id, track.id)" />
    </video>
    <div v-if="!audioOnly && session.transport !== 'iframe'" class="danmaku-layer" aria-live="off">
      <span v-for="entry in activeDanmaku" :key="`${entry.time}:${entry.text}`">{{ entry.text }}</span>
      <span v-for="comment in comments.slice(-3)" :key="comment.id" class="room-comment">{{ comment.displayName ? `${comment.displayName}: ` : "" }}{{ comment.text }}</span>
    </div>
    <p v-if="controlsVisible && session.transport === 'hls' && danmakuState === 'failed'" class="danmaku-warning" role="status">{{ t("media.danmakuFailure") }}</p>
    <label v-if="controlsVisible && captionOptions.length && syncTime === undefined" class="caption-select">
      <span>{{ t("media.captions") }}</span>
      <select v-model="selectedCaption" :aria-label="t('media.captions')">
        <option value="">{{ t("media.captionsOff") }}</option>
        <option v-for="track in captionOptions" :key="track.id" :value="track.id">{{ track.title || track.language || track.id }}</option>
      </select>
    </label>
    <p v-if="hlsError" class="media-error" role="alert">{{ hlsError }}</p>
  </div>
</template>

<style scoped>
.media-surface { position: relative; overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: 16px; background: #050608; aspect-ratio: 16 / 9; min-height: 180px; }
video { display: block; width: 100%; height: 100%; object-fit: contain; background: #050608; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
.audio-only { height: 78px; min-height: 78px; aspect-ratio: auto; background: var(--color-bg-secondary); }
.audio-only video { height: 78px; }
.danmaku-layer { pointer-events: none; position: absolute; inset: 0; overflow: hidden; display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-start; gap: .5rem; padding: 1rem; color: white; text-shadow: 0 1px 4px #000, 0 0 8px #000; font-size: clamp(.85rem, 2vw, 1.4rem); }
.danmaku-layer span { max-width: 88%; padding: .15rem .5rem; border-radius: 999px; background: #05060855; }
.danmaku-layer .room-comment { align-self: flex-start; color: #fff3ae; }
.danmaku-warning { position: absolute; bottom: .5rem; left: .6rem; margin: 0; padding: .25rem .45rem; border-radius: 6px; color: #fff; background: #1119; font-size: .72rem; }
.caption-select { position: absolute; top: .75rem; left: .75rem; display: flex; gap: .4rem; align-items: center; color: white; font-size: .8rem; }
.caption-select select { color: white; background: #111c; border: 1px solid #fff6; border-radius: 7px; padding: .3rem; }
.media-error { position: absolute; inset-inline: 1rem; bottom: 1rem; margin: 0; padding: .6rem .8rem; color: #fff; background: #8b1c1cdd; border-radius: 8px; }
</style>
