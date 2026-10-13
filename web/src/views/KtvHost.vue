<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import QRCode from "qrcode";
import type { KtvAction, KtvComment, KtvQueueItem, KtvQueueMode, KtvRoomSnapshot, KtvSelection } from "../../../shared/ktv";
import { useAuth } from "../api";
import { usePlayerStore, type Track } from "../stores/player";
import { useKtvSettingsStore } from "../stores/ktvSettings";
import NowPlaying from "./NowPlaying.vue";
import MediaSurface from "../components/MediaSurface.vue";
import { createKtvRoom, getKtvLinks, getKtvRoom, hostStorageKey, ktvRoomAction, openKtvSocket, playerIdentityKey, searchKtvRoom, type KtvSearchAudio, type KtvSearchVideo } from "../lib/ktvApi";
import { getVideoPlayback, resolveExternalVideo, saveExternalVideo, type MediaSession } from "../lib/videoApi";

const { t } = useI18n();
const auth = useAuth();
const player = usePlayerStore();
const settings = useKtvSettingsStore();
const displayName = ref(auth.displayName.value || auth.username.value || "Host");
const room = ref<KtvRoomSnapshot | null>(null);
const roomId = ref("");
const controllerToken = ref("");
const inviteUrl = ref("");
const qrData = ref("");
const busy = ref(false);
const error = ref("");
const searchText = ref("");
const searchBusy = ref(false);
const audioResults = ref<KtvSearchAudio[]>([]);
const videoResults = ref<KtvSearchVideo[]>([]);
const linkedVideos = ref<Array<{ videoId: string; videoTitle: string; offsetMs: number }>>([]);
const selectedAudio = ref<KtvSearchAudio | null>(null);
const externalUrl = ref("");
const comments = ref<KtvComment[]>([]);
const commentText = ref("");
const mediaSession = ref<MediaSession | null>(null);
const page = ref<HTMLDivElement | null>(null);
const mediaSurface = ref<InstanceType<typeof MediaSurface> | null>(null);
const stage = ref(false);
const fullscreen = ref(false);
const showStageQr = ref(false);
const showStageHelp = ref(false);
const mediaError = ref("");
const autoplayBlocked = ref(false);
const mediaTime = ref(0);
const mediaDuration = ref(0);
const mediaPlaying = ref(false);
const listenOnly = ref(false);
const mediaLoading = ref(false);
const savingVideo = ref(false);
const savedVideoItemId = ref("");
const playerSnapshotKey = "edgesonic:ktv:previous-player";
let socket: WebSocket | null = null;
let heartbeatTimer: number | undefined;
let playbackTimer: number | undefined;
let socketRetryTimer: number | undefined;
let lastFinishedId = "";
let itemGeneration = 0;
let deliberateClose = false;

const current = computed(() => room.value?.current ?? null);
const currentAudio = computed(() => !!current.value?.audioId);
const iframeTransport = computed(() => mediaSession.value?.transport === "iframe");
const iframeAudioMismatch = computed(() => iframeTransport.value && currentAudio.value);
const iframeVideoUncontrolled = computed(() => iframeTransport.value && !currentAudio.value);
const embeddedVideoAllowed = computed(() => room.value
  ? room.value.mediaMode !== "compatible" || room.value.allowEmbeddedVideo
  : settings.mediaMode !== "compatible" || settings.allowEmbeddedVideo);
const canAdvance = computed(() => !!current.value || room.value?.queue[0]?.status === "queued");
const linkedOffset = computed(() => current.value?.offsetMs ?? 0);
const activeComments = computed(() => comments.value.filter((item) => !current.value || item.itemId === current.value.id));
const fullInviteUrl = computed(() => new URL(inviteUrl.value, window.location.href).toString());
const stagePosition = computed(() => currentAudio.value ? player.currentTime : mediaTime.value);
const stagePlaying = computed(() => currentAudio.value ? player.playing : mediaPlaying.value);

function playerId() {
  let id = sessionStorage.getItem(playerIdentityKey);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(playerIdentityKey, id); }
  return id;
}

function savePreviousPlayer() {
  if (sessionStorage.getItem(playerSnapshotKey)) return;
  sessionStorage.setItem(playerSnapshotKey, JSON.stringify({
    queue: player.queue.map((track) => ({ ...track })), index: player.index,
    time: player.currentTime, playing: player.playing,
  }));
  if (player.playing) player.toggle();
}

function restorePreviousPlayer() {
  const saved = sessionStorage.getItem(playerSnapshotKey);
  if (!saved) return;
  sessionStorage.removeItem(playerSnapshotKey);
  try {
    const value = JSON.parse(saved) as { queue: Track[]; index: number; time: number; playing: boolean };
    player.setQueue(value.queue, value.index, { autoplay: value.playing, startTime: value.time });
  } catch { player.clear(); }
}

function persistHost() {
  if (!roomId.value || !controllerToken.value) return;
  sessionStorage.setItem(hostStorageKey, JSON.stringify({ roomId: roomId.value, controllerToken: controllerToken.value, playerId: playerId() }));
}

function stopSocket() {
  const previous = socket;
  socket = null;
  previous?.close();
  if (socketRetryTimer !== undefined) clearTimeout(socketRetryTimer);
  socketRetryTimer = undefined;
}

function connectSocket() {
  if (!roomId.value || !controllerToken.value || !room.value?.open) return;
  stopSocket();
  const connection = openKtvSocket(roomId.value, { kind: "controller", token: controllerToken.value }, (raw) => {
    if (socket !== connection) return;
    const event = raw as { type?: string; room?: KtvRoomSnapshot; comment?: KtvComment };
    if (event.type === "state" && event.room) room.value = event.room;
    if (event.type === "comment" && event.comment) comments.value = [...comments.value.slice(-99), event.comment];
    if (event.type === "closed") handleClosed();
  }, () => {
    if (socket !== connection) return;
    if (room.value?.open) socketRetryTimer = window.setTimeout(connectSocket, 2500);
  });
  socket = connection;
}

function startHeartbeat() {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    if (!room.value?.open) return;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: "heartbeat" }));
    else void perform({ action: "heartbeat" }, false);
  }, 20_000);
  if (playbackTimer !== undefined) clearInterval(playbackTimer);
  playbackTimer = window.setInterval(() => {
    if (!room.value?.open || !room.value.current) return;
    if (iframeVideoUncontrolled.value) return;
    const position = currentAudio.value ? player.currentTime : mediaTime.value;
    const playing = currentAudio.value ? player.playing : mediaPlaying.value;
    const payload = { action: "playback", currentId: room.value.current.id, playing, position } as const;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    else void perform(payload, false);
  }, 4000);
}

async function loadQr() {
  if (!inviteUrl.value) return;
  try { qrData.value = await QRCode.toDataURL(new URL(inviteUrl.value, location.href).toString(), { margin: 1, width: 220, color: { dark: "#17191d", light: "#ffffff" } }); }
  catch { qrData.value = ""; }
}

async function attachRoom() {
  connectSocket();
  startHeartbeat();
  await loadQr();
}

async function startRoom() {
  if (!settings.enabled || busy.value) return;
  busy.value = true;
  error.value = "";
  deliberateClose = false;
  savePreviousPlayer();
  try {
    const result = await createKtvRoom({ playerId: playerId(), mode: settings.mode, displayName: displayName.value.trim() || "Host" });
    room.value = result.room;
    roomId.value = result.room.id;
    controllerToken.value = result.controllerToken;
    inviteUrl.value = result.inviteUrl;
    persistHost();
    await attachRoom();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable");
    restorePreviousPlayer();
  } finally { busy.value = false; }
}

async function recoverRoom() {
  const saved = sessionStorage.getItem(hostStorageKey);
  if (!saved) return;
  try {
    const value = JSON.parse(saved) as { roomId?: string; controllerToken?: string; playerId?: string };
    if (!value.roomId || !value.controllerToken) return;
    roomId.value = value.roomId;
    controllerToken.value = value.controllerToken;
    if (value.playerId) sessionStorage.setItem(playerIdentityKey, value.playerId);
    const result = await getKtvRoom(roomId.value, controllerToken.value);
    room.value = result.room;
    inviteUrl.value = result.inviteUrl;
    await attachRoom();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("ktv.roomUnavailable");
    sessionStorage.removeItem(hostStorageKey);
    restorePreviousPlayer();
  }
}

async function perform(action: KtvAction, showError = true) {
  if (!roomId.value || !controllerToken.value) return;
  try {
    const result = await ktvRoomAction(roomId.value, controllerToken.value, action);
    room.value = result.room;
    if (result.inviteUrl) {
      inviteUrl.value = result.inviteUrl;
      await loadQr();
    }
    persistHost();
    return result;
  } catch (cause) {
    if (showError) error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable");
    if ((cause as { status?: number }).status === 404 || (cause as { status?: number }).status === 410) handleClosed();
  }
}

async function closeRoom() {
  if (!confirm(t("ktv.closeConfirm"))) return;
  deliberateClose = true;
  const result = await perform({ action: "close" });
  if (result) handleClosed();
  else deliberateClose = false;
}

function handleClosed() {
  stopSocket();
  room.value = null;
  roomId.value = "";
  controllerToken.value = "";
  inviteUrl.value = "";
  qrData.value = "";
  sessionStorage.removeItem(hostStorageKey);
  mediaSession.value = null;
  if (player.playing) player.toggle();
  restorePreviousPlayer();
  error.value = deliberateClose ? "" : t("ktv.roomUnavailable");
}

async function copyInvite() {
  try { await navigator.clipboard.writeText(new URL(inviteUrl.value, location.href).toString()); }
  catch { error.value = "Copy failed. Select the request link to copy it."; }
}

async function search() {
  if (!room.value || !searchText.value.trim()) return;
  searchBusy.value = true;
  error.value = "";
  try {
    const result = await searchKtvRoom(room.value.id, { kind: "controller", token: controllerToken.value }, searchText.value.trim());
    audioResults.value = result.audio;
    videoResults.value = result.videos;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable"); }
  finally { searchBusy.value = false; }
}

async function selectAudio(audio: KtvSearchAudio) {
  selectedAudio.value = audio;
  linkedVideos.value = [];
  try {
    const result = await getKtvLinks(room.value!.id, controllerToken.value, audio.id);
    linkedVideos.value = result.links.map((link) => ({ videoId: link.videoId, videoTitle: link.videoTitle, offsetMs: link.offsetMs }));
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable"); }
}

async function enqueue(selection: KtvSelection) {
  await perform({ action: "enqueue", selection });
}
function addAudio(audio: KtvSearchAudio) { void enqueue({ audioId: audio.id }); }
function addVideo(video: KtvSearchVideo) { void enqueue({ audioId: selectedAudio.value?.id, videoId: video.id }); }
function normalizeExternal(value: string) {
  const clean = value.trim();
  if (/^BV[0-9A-Za-z]+$/.test(clean)) return `https://www.bilibili.com/video/${clean}`;
  if (/^av\d+$/i.test(clean)) return `https://www.bilibili.com/video/${clean}`;
  return clean;
}
function requestExternal() {
  if (!embeddedVideoAllowed.value) return;
  const url = normalizeExternal(externalUrl.value);
  if (!url) return;
  void enqueue({ ...(selectedAudio.value ? { audioId: selectedAudio.value.id } : {}), externalUrl: url });
  externalUrl.value = "";
}

function sendComment() {
  const text = commentText.value.trim();
  if (!text) return;
  commentText.value = "";
  void perform({ action: "comment", text });
}

async function loadCurrentMedia(item: KtvQueueItem | null) {
  const generation = ++itemGeneration;
  mediaSession.value = null;
  mediaError.value = "";
  autoplayBlocked.value = false;
  listenOnly.value = !item?.audioId && item?.listenOnly === true;
  mediaTime.value = room.value?.playback.position ?? 0;
  mediaDuration.value = item?.duration ?? 0;
  mediaPlaying.value = room.value?.playback.playing ?? false;
  mediaLoading.value = false;
  if (!item) return;
  if (item.audioId) {
    player.setQueue([{ id: item.audioId, title: item.title, artist: item.artist || "", album: "", duration: item.duration ?? 0 }], 0,
      { autoplay: mediaPlaying.value, startTime: mediaTime.value });
  } else if (player.playing) player.toggle();
  if (!item.videoId && !item.externalUrl) return;
  mediaLoading.value = true;
  try {
    const result = item.videoId
      ? await getVideoPlayback(item.videoId, room.value?.mediaMode)
      : await resolveExternalVideo(item.externalUrl!, room.value?.mediaMode);
    if (generation !== itemGeneration) {
      void fetch(`/edgesonic/media/${encodeURIComponent(result.session.id)}`, { method: "DELETE" }).catch(() => {});
      return;
    }
    mediaSession.value = result.session;
    mediaDuration.value = result.session.duration ?? item.duration ?? 0;
  } catch (cause) {
    if (generation === itemGeneration) mediaError.value = cause instanceof Error ? cause.message : t("ktv.playbackError");
  } finally { if (generation === itemGeneration) mediaLoading.value = false; }
}

watch(() => room.value?.current?.id, () => { void loadCurrentMedia(current.value); }, { immediate: true });
watch(() => player.endedSequence, (sequence, previous) => {
  if (sequence === previous || !current.value?.audioId || current.value.id === lastFinishedId) return;
  lastFinishedId = current.value.id;
  void perform({ action: "next", currentId: current.value.id });
});

function updateMediaClock(time: number) { mediaTime.value = time; }
function updateMediaPlaying(value: boolean) { mediaPlaying.value = value; }
async function saveCurrentVideo() {
  const item = current.value;
  if (!item?.externalUrl || savingVideo.value) return;
  savingVideo.value = true;
  try {
    await saveExternalVideo(item.externalUrl);
    savedVideoItemId.value = item.id;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t("videos.saveFailed"); }
  finally { savingVideo.value = false; }
}
function videoSyncTime() { return player.currentTime + linkedOffset.value / 1000; }
function toggleListenOnly() {
  if (current.value?.audioId || (!current.value?.videoId && !current.value?.externalUrl)) return;
  listenOnly.value = !listenOnly.value;
}

async function toggleStagePlayback() {
  if (currentAudio.value) player.toggle();
  else if (iframeVideoUncontrolled.value) return;
  else {
    try { await mediaSurface.value?.togglePlayback(); }
    catch { autoplayBlocked.value = true; }
  }
}

function seekStage(delta: number) {
  const duration = currentAudio.value ? player.duration : mediaDuration.value;
  if (iframeVideoUncontrolled.value) return;
  const next = Math.max(0, Math.min(duration || Infinity, stagePosition.value + delta));
  if (currentAudio.value) player.seek(next);
  else mediaSurface.value?.seekTo(next);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement === page.value) await document.exitFullscreen();
    else await page.value?.requestFullscreen();
  } catch { fullscreen.value = document.fullscreenElement === page.value; }
}

async function enterStage() {
  stage.value = true;
  await toggleFullscreen();
}

async function returnToPreparation() {
  stage.value = false;
  if (document.fullscreenElement === page.value) await document.exitFullscreen().catch(() => {});
}

function onFullscreenChange() { fullscreen.value = document.fullscreenElement === page.value; }

function onStageKeydown(event: KeyboardEvent) {
  if (!stage.value || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))) return;
  if (event.code === "Space") { event.preventDefault(); void toggleStagePlayback(); }
  else if (event.key === "ArrowLeft") { event.preventDefault(); seekStage(-10); }
  else if (event.key === "ArrowRight") { event.preventDefault(); seekStage(10); }
  else if (event.key.toLowerCase() === "n") void perform({ action: "next", currentId: current.value?.id ?? null });
  else if (event.key.toLowerCase() === "q") showStageQr.value = !showStageQr.value;
  else if (event.key.toLowerCase() === "f") void toggleFullscreen();
  else if (event.key.toLowerCase() === "b") void returnToPreparation();
  else if (event.key === "?") showStageHelp.value = !showStageHelp.value;
}

function onVisibilityChange() {
  if (document.hidden) return;
  if (room.value?.open && (!socket || socket.readyState > WebSocket.OPEN)) connectSocket();
}

onMounted(async () => {
  document.addEventListener("fullscreenchange", onFullscreenChange);
  window.addEventListener("keydown", onStageKeydown);
  await settings.load();
  if (settings.enabled) {
    if (sessionStorage.getItem(hostStorageKey)) savePreviousPlayer();
    await recoverRoom();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  window.removeEventListener("keydown", onStageKeydown);
  itemGeneration++;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stopSocket();
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  if (playbackTimer !== undefined) clearInterval(playbackTimer);
  if (player.playing && currentAudio.value) player.toggle();
});
</script>

<template>
  <div ref="page" class="ktv-page" :class="{ 'is-stage': stage }">
    <header class="page-header ktv-header">
      <div>
        <div class="mono-label">EDGE SONIC / KTV</div>
        <h1 class="page-title">{{ t("ktv.hostTitle") }}</h1>
        <p class="page-description">{{ t("ktv.intro") }}</p>
      </div>
      <button v-if="room" type="button" class="btn-danger btn-sm" @click="closeRoom">{{ t("ktv.closeRoom") }}</button>
      <button v-if="room && !stage" type="button" class="btn-primary btn-sm" @click="enterStage">{{ t("ktv.enterStage") }}</button>
    </header>

    <div v-if="!settings.enabled" class="card ktv-notice">
      <p>{{ t("ktv.disabled") }}</p>
      <router-link class="btn-primary" to="/tools">{{ t("ktv.openSettings") }}</router-link>
    </div>

    <div v-else-if="!room" class="card ktv-start-card">
      <label class="form-row">
        <span class="tc-key">{{ t("ktv.nickname") }}</span>
        <input v-model="displayName" class="form-input" maxlength="32" />
      </label>
      <button class="btn-primary" :disabled="busy" @click="startRoom">{{ busy ? t("ktv.starting") : t("ktv.startRoom") }}</button>
    </div>

    <template v-else>
      <div class="ktv-top-grid">
        <section class="card invite-card">
          <div class="invite-copy">
            <div class="mono-label">{{ t("ktv.invite") }}</div>
            <h2>{{ t("ktv.participantCount", { count: room.participants.length }) }}</h2>
            <p class="feature-desc">{{ t("ktv.expires", { time: new Date(room.expiresAt > 1e12 ? room.expiresAt : room.expiresAt * 1000).toLocaleTimeString() }) }}</p>
            <input class="form-input invite-url" :value="fullInviteUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
            <button class="btn-secondary btn-sm" @click="copyInvite">{{ t("ktv.copyLink") }}</button>
            <button class="btn-secondary btn-sm" @click="perform({ action: 'rotate' })">{{ t("ktv.rotateLink") }}</button>
          </div>
          <img v-if="qrData" class="invite-qr" :src="qrData" alt="QR code to join the KTV room" />
        </section>

        <section class="card order-card">
          <div class="mono-label">{{ t("ktv.mode") }}</div>
          <div class="order-options">
            <button class="btn-secondary btn-sm" :class="{ selected: room.mode === 'fair' }" @click="perform({ action: 'mode', mode: 'fair' })">{{ t("ktv.fair") }}</button>
            <button class="btn-secondary btn-sm" :class="{ selected: room.mode === 'fifo' }" @click="perform({ action: 'mode', mode: 'fifo' })">{{ t("ktv.fifo") }}</button>
          </div>
          <p class="feature-desc">{{ room.mode === 'fair' ? t("ktv.modeFairHint") : t("ktv.modeFifoHint") }}</p>
          <div class="participants">
            <span v-for="person in room.participants" :key="person.id" class="participant-chip">{{ person.displayName }}<small v-if="person.host">HOST</small></span>
          </div>
          <form class="host-rename" @submit.prevent="perform({ action: 'rename', displayName: displayName.trim() })">
            <input v-model="displayName" class="form-input" maxlength="32" :placeholder="t('ktv.nickname')" />
            <button class="btn-secondary btn-sm" :disabled="!displayName.trim()">{{ t("ktv.rename") }}</button>
          </form>
        </section>
      </div>

      <div class="ktv-main-grid">
        <section class="card current-card">
          <div v-if="stage" class="stage-toolbar" role="toolbar" :aria-label="t('ktv.stageHelp')">
            <button class="btn-secondary btn-sm" :aria-label="t('ktv.stageHelp')" :title="t('ktv.stageHelp')" @click="showStageHelp = !showStageHelp">{{ t("ktv.controls") }}</button>
            <button class="btn-secondary btn-sm" @click="showStageQr = !showStageQr">{{ showStageQr ? t("ktv.hideQr") : t("ktv.showQr") }}</button>
            <button class="btn-secondary btn-sm" :disabled="!current || iframeVideoUncontrolled" @click="seekStage(-10)">−10s</button>
            <button class="btn-primary btn-sm" :disabled="!current || iframeVideoUncontrolled" @click="toggleStagePlayback">{{ stagePlaying ? t("ktv.pause") : t("ktv.play") }}</button>
            <button class="btn-secondary btn-sm" :disabled="!current || iframeVideoUncontrolled" @click="seekStage(10)">+10s</button>
            <button class="btn-secondary btn-sm" :disabled="!canAdvance" @click="perform({ action: 'next', currentId: current?.id ?? null })">{{ t("ktv.next") }}</button>
            <button class="btn-secondary btn-sm" @click="toggleFullscreen">{{ fullscreen ? t("ktv.exitFullscreen") : t("ktv.fullscreen") }}</button>
            <button class="btn-secondary btn-sm" @click="returnToPreparation">{{ t("ktv.backToPreparation") }}</button>
          </div>
          <div v-if="stage && showStageHelp" class="stage-help" role="status">{{ t("ktv.stageShortcuts") }}</div>
          <aside v-if="stage && showStageQr" class="stage-qr-panel">
            <img v-if="qrData" class="invite-qr" :src="qrData" :alt="t('ktv.joinQrAlt')" />
            <p>{{ t("ktv.invite") }}</p>
            <button class="btn-secondary btn-sm" @click="copyInvite">{{ t("ktv.copyLink") }}</button>
          </aside>
          <div class="mono-label">{{ current ? t("ktv.status.playing") : t("ktv.chooseSource") }}</div>
          <div v-if="current" class="current-layout">
            <MediaSurface
              v-if="mediaSession"
              ref="mediaSurface"
              :controls-visible="!stage"
              :session="mediaSession"
              :audio-only="listenOnly"
              :muted="currentAudio && !listenOnly"
              :sync-time="currentAudio && !listenOnly ? videoSyncTime() : undefined"
              :sync-playing="currentAudio && !listenOnly ? player.playing : undefined"
              :initial-time="mediaTime"
              :start-playing="mediaPlaying"
              :comments="activeComments"
              @time="updateMediaClock"
              @duration="mediaDuration = $event"
              @playing="updateMediaPlaying"
              @ended="currentAudio || iframeTransport ? undefined : perform({ action: 'next', currentId: current.id })"
              @error="mediaError = $event"
              @autoplay-blocked="autoplayBlocked = true"
            />
            <div v-else-if="mediaLoading" class="media-placeholder">{{ t("common.loading") }}</div>
            <p v-if="mediaError" class="error-text" role="alert">{{ mediaError }}</p>
            <p v-if="autoplayBlocked" class="feature-desc" role="status">{{ t("ktv.autoplayBlocked") }}</p>
            <p v-if="iframeAudioMismatch" class="feature-desc" role="status">{{ t("ktv.iframeAudioMismatch") }}</p>
            <p v-else-if="iframeVideoUncontrolled" class="feature-desc" role="status">{{ t("ktv.iframeVideoUncontrolled") }}</p>
            <div class="current-copy">
              <div class="mono-label">{{ t("ktv.requester", { name: current.displayName }) }}</div>
              <h2>{{ current.title }}</h2>
              <p v-if="current.artist" class="feature-desc">{{ current.artist }}</p>
              <div class="current-actions">
                <button v-if="currentAudio" class="btn-secondary btn-sm" @click="player.toggle()">{{ player.playing ? t("ktv.pause") : t("ktv.play") }}</button>
                <button v-if="currentAudio" class="btn-secondary btn-sm" @click="perform({ action: 'next', currentId: current.id })">{{ t("ktv.next") }}</button>
                <button v-if="mediaSession && !current.audioId && !iframeTransport" class="btn-secondary btn-sm" :disabled="!listenOnly && !mediaSession.audioTracks.length" @click="toggleListenOnly">{{ listenOnly ? t("ktv.watchVideo") : t("ktv.listenOnly") }}</button>
                <button v-if="current.externalUrl && auth.hasPerm('upload')" class="btn-secondary btn-sm" :disabled="savingVideo || savedVideoItemId === current.id" @click="saveCurrentVideo">{{ savedVideoItemId === current.id ? t("videos.saved") : t("videos.save") }}</button>
                <p v-if="mediaSession && !current.audioId && !mediaSession.audioTracks.length" class="feature-desc">{{ t("media.audioTrackUnavailable") }}</p>
              </div>
              <label v-if="currentAudio && player.duration > 0" class="ktv-seek">
                <input type="range" min="0" step="0.1" :max="player.duration" :value="player.currentTime" @input="player.seek(Number(($event.target as HTMLInputElement).value))" />
                <span>{{ Math.floor(player.currentTime / 60) }}:{{ String(Math.floor(player.currentTime % 60)).padStart(2, '0') }} / {{ Math.floor(player.duration / 60) }}:{{ String(Math.floor(player.duration % 60)).padStart(2, '0') }}</span>
              </label>
            </div>
          </div>
          <NowPlaying v-if="currentAudio && player.current?.id === current?.audioId" class="ktv-lyrics" />
          <div v-if="!current" class="empty-current">{{ t("ktv.emptyQueue") }}</div>
          <div v-if="stage && current && !iframeVideoUncontrolled" class="stage-progress" aria-live="off">{{ Math.floor(stagePosition / 60) }}:{{ String(Math.floor(stagePosition % 60)).padStart(2, '0') }} / {{ Math.floor((currentAudio ? player.duration : mediaDuration) / 60) }}:{{ String(Math.floor((currentAudio ? player.duration : mediaDuration) % 60)).padStart(2, '0') }}</div>
        </section>

        <section class="card queue-card">
          <div class="queue-heading">
            <div><div class="mono-label">{{ t("ktv.queue") }}</div><h2>{{ room.queue.length }}</h2></div>
            <button class="btn-primary btn-sm" :disabled="!canAdvance" @click="perform({ action: 'next', currentId: current?.id ?? null })">{{ t("ktv.next") }}</button>
          </div>
          <p v-if="room.queue.length === 0" class="feature-desc">{{ t("ktv.emptyQueue") }}</p>
          <ol v-else class="queue-list">
            <li v-for="item in room.queue" :key="item.id" class="queue-item">
              <div class="queue-item-title"><strong>{{ item.title }}</strong><span>{{ t(`ktv.status.${item.status}`) }}</span></div>
              <small>{{ t("ktv.requester", { name: item.displayName }) }}<template v-if="item.artist"> · {{ item.artist }}</template></small>
              <small v-if="item.error" class="error-text">{{ item.error }}</small>
              <button class="btn-secondary btn-sm" @click="perform({ action: 'remove', itemId: item.id })">{{ t("ktv.remove") }}</button>
            </li>
          </ol>
          <div class="comment-area">
            <div class="mono-label">{{ t("ktv.comments") }}</div>
            <div class="comment-list" aria-live="polite">
              <p v-for="comment in activeComments.slice(-5)" :key="comment.id"><strong>{{ comment.displayName }}:</strong> {{ comment.text }}</p>
              <p v-if="!activeComments.length" class="feature-desc">—</p>
            </div>
            <form class="comment-form" @submit.prevent="sendComment">
              <input v-model="commentText" class="form-input" maxlength="120" :placeholder="t('ktv.commentPlaceholder')" />
              <button class="btn-secondary btn-sm" :disabled="!commentText.trim()">{{ t("ktv.sendComment") }}</button>
            </form>
          </div>
        </section>
      </div>

      <section class="card request-card">
        <div class="mono-label">{{ t("ktv.search") }}</div>
        <form class="search-row" @submit.prevent="search">
          <input v-model="searchText" class="form-input" :placeholder="t('ktv.searchPlaceholder')" />
          <button class="btn-primary" :disabled="searchBusy || !searchText.trim()">{{ searchBusy ? t("common.loading") : t("ktv.searchButton") }}</button>
        </form>
        <div class="search-columns">
          <div>
            <h3>{{ t("ktv.audio") }}</h3>
            <p v-if="!audioResults.length" class="feature-desc">—</p>
            <div v-for="audio in audioResults" :key="audio.id" class="search-result">
              <button class="result-main" @click="selectAudio(audio)"><strong>{{ audio.title }}</strong><small>{{ audio.artist }}</small></button>
              <button class="btn-secondary btn-sm" @click="addAudio(audio)">{{ t("ktv.addAudio") }}</button>
            </div>
          </div>
          <div>
            <h3>{{ t("ktv.video") }}</h3>
            <p v-if="!videoResults.length" class="feature-desc">—</p>
            <div v-for="video in videoResults" :key="video.id" class="search-result">
              <strong>{{ video.title }}</strong>
              <button class="btn-secondary btn-sm" @click="addVideo(video)">{{ selectedAudio ? t("ktv.addPair") : t("ktv.addVideo") }}</button>
            </div>
          </div>
        </div>
        <div v-if="selectedAudio" class="linked-choices">
          <h3>{{ t("ktv.boundAudio") }} · {{ selectedAudio.title }}</h3>
          <button class="btn-secondary btn-sm" @click="selectedAudio = null; linkedVideos = []">{{ t("common.clear") }}</button>
          <button v-for="video in linkedVideos" :key="video.videoId" class="btn-secondary btn-sm" @click="enqueue({ audioId: selectedAudio?.id, videoId: video.videoId, offsetMs: video.offsetMs })">{{ video.videoTitle }} · {{ t("ktv.addPair") }}</button>
        </div>
        <form v-if="embeddedVideoAllowed" class="external-row" @submit.prevent="requestExternal">
          <input v-model="externalUrl" class="form-input" :placeholder="t('ktv.externalPlaceholder')" />
          <button class="btn-secondary" :disabled="!externalUrl.trim()">{{ t("ktv.requestExternal") }}</button>
        </form>
        <p v-else-if="room.mediaMode === 'compatible'" class="feature-desc">{{ t("settings.ktv.compatibilityDisabled") }}</p>
      </section>
    </template>
    <p v-if="error" class="error-text ktv-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.ktv-page { display: grid; gap: 1rem; max-width: 1440px; margin: 0 auto; }
.ktv-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; }
.card { padding: 1rem; }
.ktv-notice, .ktv-start-card { display: grid; gap: 1rem; max-width: 560px; }
.form-row { display: grid; gap: .5rem; }
.ktv-top-grid, .ktv-main-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(280px, .9fr); gap: 1rem; align-items: start; }
.invite-card { display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
.invite-copy { min-width: 0; flex: 1; }
.invite-copy h2, .queue-heading h2 { margin: .3rem 0; }
.invite-url { margin: .5rem 0; font-size: .85rem; }
.invite-qr { width: 160px; height: 160px; padding: .35rem; background: white; border-radius: 10px; }
.order-card { display: grid; gap: .75rem; }
.order-options, .participants, .current-actions { display: flex; flex-wrap: wrap; gap: .45rem; }
.host-rename { display: flex; gap: .4rem; }
.host-rename input { min-width: 0; flex: 1; }
.selected { border-color: var(--color-accent-primary); color: var(--color-accent-primary); }
.participant-chip { display: inline-flex; align-items: center; gap: .35rem; border: 1px solid var(--color-border-subtle); border-radius: 999px; padding: .3rem .55rem; font-size: .82rem; }
.participant-chip small { color: var(--color-accent-primary); }
.ktv-main-grid { grid-template-columns: minmax(0, 1.25fr) minmax(300px, .75fr); }
.current-card { min-width: 0; }
.current-layout { display: grid; gap: .85rem; margin-top: .7rem; }
.current-copy h2 { margin: .35rem 0; }
.current-copy { display: grid; gap: .4rem; }
.media-placeholder { aspect-ratio: 16/9; display: grid; place-items: center; border-radius: 16px; background: var(--color-bg-secondary); color: var(--color-text-muted); }
.empty-current { display: grid; place-items: center; min-height: 140px; color: var(--color-text-muted); }
.ktv-seek { display: flex; align-items: center; gap: .65rem; font-size: .8rem; color: var(--color-text-muted); }
.ktv-seek input { flex: 1; min-width: 0; accent-color: var(--color-accent-primary); }
.ktv-lyrics { height: 240px; min-height: 220px; margin-top: 1rem; overflow: hidden; border-top: 1px solid var(--color-border-subtle); }
.ktv-lyrics :deep(.nowplaying) { height: 230px; min-height: 0; padding: .5rem; grid-template-columns: minmax(0, 1fr); }
.ktv-lyrics :deep(.np-left) { display: none; }
.ktv-lyrics :deep(.np-right) { padding: 0; }
.queue-card { min-width: 0; }
.queue-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: .5rem; }
.queue-list { display: grid; gap: .65rem; list-style: none; margin: .75rem 0; padding: 0; max-height: 420px; overflow: auto; }
.queue-item { display: grid; grid-template-columns: 1fr auto; gap: .3rem .6rem; padding: .65rem 0; border-top: 1px solid var(--color-border-subtle); }
.queue-item-title { display: flex; justify-content: space-between; gap: .5rem; grid-column: 1 / -1; }
.queue-item small { color: var(--color-text-muted); }
.queue-item button { grid-column: 2; grid-row: 2; }
.comment-area { border-top: 1px solid var(--color-border-subtle); padding-top: .75rem; }
.comment-list { max-height: 150px; overflow: auto; font-size: .85rem; }
.comment-list p { margin: .35rem 0; }
.comment-form, .search-row, .external-row { display: flex; gap: .55rem; margin-top: .65rem; }
.comment-form .form-input, .search-row .form-input, .external-row .form-input { flex: 1; min-width: 0; }
.request-card { display: grid; gap: .6rem; }
.search-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.search-columns h3, .linked-choices h3 { font-size: .9rem; margin: .3rem 0 .55rem; }
.search-result { display: flex; align-items: center; justify-content: space-between; gap: .55rem; padding: .45rem 0; border-top: 1px solid var(--color-border-subtle); }
.result-main { display: grid; min-width: 0; text-align: left; border: 0; color: inherit; background: transparent; cursor: pointer; }
.result-main strong, .search-result > strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-main small { color: var(--color-text-muted); }
.linked-choices { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; border-top: 1px solid var(--color-border-subtle); padding-top: .6rem; }
.linked-choices h3 { flex-basis: 100%; }
.error-text { color: var(--color-danger, #d13438); }
.ktv-error { margin: 0; }
.stage-toolbar, .stage-help, .stage-qr-panel, .stage-progress { display: none; }
.ktv-page.is-stage { position: fixed; inset: 0; z-index: 1200; display: block; max-width: none; overflow: auto; padding: 1rem; color: #fff; background: #050608; }
.is-stage > .ktv-header, .is-stage > .ktv-top-grid, .is-stage > .request-card, .is-stage > .ktv-error { display: none; }
.is-stage .ktv-main-grid { display: block; margin: 0 auto; max-width: 1500px; }
.is-stage .queue-card { display: none; }
.is-stage .current-card { position: relative; min-height: calc(100dvh - 2rem); display: flex; flex-direction: column; justify-content: center; border: 0; padding: 3.5rem 0 2rem; background: transparent; box-shadow: none; }
.is-stage .current-card > .mono-label { color: #bdc2ca; text-align: center; }
.is-stage .current-layout { width: 100%; max-width: 1400px; margin: .75rem auto 0; }
.is-stage .current-layout :deep(.media-surface) { width: 100%; aspect-ratio: 16 / 9; }
.is-stage .current-layout :deep(.media-surface.audio-only) { height: auto; min-height: 210px; }
.is-stage .current-copy { align-items: center; text-align: center; }
.is-stage .current-copy h2 { margin: .25rem 0; font-size: clamp(1.4rem, 3vw, 2.4rem); }
.is-stage .current-copy .current-actions, .is-stage .current-copy .ktv-seek { display: none; }
.is-stage .ktv-lyrics { width: min(100%, 1100px); height: min(26vh, 240px); min-height: 130px; margin: .75rem auto 0; border: 0; }
.is-stage .ktv-lyrics :deep(.nowplaying) { height: 100%; }
.is-stage .stage-toolbar { position: fixed; z-index: 3; inset: auto 1rem 1rem; display: flex; justify-content: center; flex-wrap: wrap; gap: .5rem; padding: .75rem; border: 1px solid #ffffff26; border-radius: 16px; background: #15171ddd; backdrop-filter: blur(12px); }
.is-stage .stage-help { position: fixed; z-index: 4; left: 1rem; bottom: 5.5rem; display: block; max-width: min(34rem, calc(100vw - 2rem)); padding: .7rem 1rem; border-radius: 10px; color: #fff; background: #15171df2; }
.is-stage .stage-qr-panel { position: fixed; z-index: 3; top: 1rem; right: 1rem; display: grid; justify-items: center; gap: .5rem; width: 190px; padding: .75rem; border: 1px solid #ffffff26; border-radius: 14px; background: #15171ddd; text-align: center; }
.is-stage .stage-qr-panel .invite-qr { width: 150px; height: 150px; }
.is-stage .stage-qr-panel p { margin: 0; font-size: .8rem; }
.is-stage .stage-progress { position: fixed; z-index: 2; bottom: 5.7rem; left: 50%; display: block; transform: translateX(-50%); color: #fff; font-variant-numeric: tabular-nums; text-shadow: 0 1px 4px #000; }
.is-stage .empty-current { min-height: 35vh; }
@media (max-width: 850px) { .ktv-top-grid, .ktv-main-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 560px) { .invite-card { align-items: flex-start; } .invite-qr { width: 100px; height: 100px; } .search-columns { grid-template-columns: minmax(0, 1fr); } .comment-form, .external-row { flex-direction: column; } }
@media (max-width: 560px) { .ktv-page.is-stage { padding: .5rem; } .is-stage .current-card { min-height: calc(100dvh - 1rem); padding-top: 4rem; padding-bottom: 5.5rem; } .is-stage .stage-toolbar { inset: auto .5rem .5rem; gap: .35rem; padding: .55rem; } .is-stage .stage-toolbar button { padding-inline: .55rem; } .is-stage .stage-progress { bottom: 5.2rem; } .is-stage .stage-qr-panel { top: .5rem; right: .5rem; width: 150px; } .is-stage .stage-qr-panel .invite-qr { width: 110px; height: 110px; } }
</style>
