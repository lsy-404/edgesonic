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
import Icon from "../components/Icon.vue";
import MediaAccountsCard from "../components/MediaAccountsCard.vue";
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
const stageQrData = ref("");
const qrModules = ref(33);
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
const stageControlsVisible = ref(false);
const fullscreen = ref(false);
const showStageQr = ref(true);
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
let stageControlsTimer: number | undefined;

const current = computed(() => room.value?.current ?? null);
const currentAudio = computed(() => !!current.value?.audioId);
const iframeTransport = computed(() => mediaSession.value?.transport === "iframe");
const iframeAudioMismatch = computed(() => iframeTransport.value && currentAudio.value);
const iframeVideoUncontrolled = computed(() => iframeTransport.value && !currentAudio.value);
const hostMediaMode = computed(() => settings.canUseContainer ? settings.mediaMode : "compatible");
const embeddedVideoAllowed = computed(() => room.value
  ? room.value.mediaMode !== "compatible" || room.value.allowEmbeddedVideo
  : hostMediaMode.value !== "compatible" || settings.allowEmbeddedVideo);
const canAdvance = computed(() => !!current.value || room.value?.queue[0]?.status === "queued");
const linkedOffset = computed(() => current.value?.offsetMs ?? 0);
const activeComments = computed(() => comments.value.filter((item) => !current.value || item.itemId === current.value.id));
const roomCode = computed(() => inviteUrl.value ? new URL(inviteUrl.value, window.location.href).searchParams.get("c") || "" : "");
const fullInviteUrl = computed(() => new URL(inviteUrl.value, window.location.href).toString());
const stagePosition = computed(() => currentAudio.value ? player.currentTime : mediaTime.value);
const stageDuration = computed(() => currentAudio.value ? player.duration : mediaDuration.value);
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

function applyRoom(next: KtvRoomSnapshot) {
  if (!room.value || room.value.id !== next.id || next.version >= room.value.version) room.value = next;
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
    if (event.type === "state" && event.room) applyRoom(event.room);
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
  try {
    const url = new URL(inviteUrl.value, location.href).toString();
    qrModules.value = QRCode.create(url, { errorCorrectionLevel: "H" }).modules.size;
    qrData.value = await QRCode.toDataURL(url, { margin: 0, width: 220, errorCorrectionLevel: "H", color: { dark: "#17191dff", light: "#ffffffff" } });
    stageQrData.value = await QRCode.toDataURL(url, { margin: 0, width: 220, errorCorrectionLevel: "H", color: { dark: "#17191dff", light: "#ffffff47" } });
  } catch { qrData.value = ""; stageQrData.value = ""; }
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
  showStageQr.value = true;
  savePreviousPlayer();
  try {
    const result = await createKtvRoom({ playerId: playerId(), mode: settings.mode, displayName: displayName.value.trim() || "Host" });
    applyRoom(result.room);
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
    applyRoom(result.room);
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
    applyRoom(result.room);
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
  stage.value = false;
  clearStageControlsTimer();
  if (document.fullscreenElement === page.value) void document.exitFullscreen().catch(() => {});
  stopSocket();
  room.value = null;
  roomId.value = "";
  controllerToken.value = "";
  inviteUrl.value = "";
  qrData.value = "";
  stageQrData.value = "";
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
function requestExternal() {
  if (!embeddedVideoAllowed.value) return;
  const url = externalUrl.value.trim();
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
  if (!item) {
    if (room.value?.open && player.playing) player.toggle();
    return;
  }
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
      if (result.session.transport === "hls") void fetch(`/edgesonic/media/${encodeURIComponent(result.session.id)}`, { method: "DELETE" }).catch(() => {});
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

function seekStageTo(position: number) {
  if (iframeVideoUncontrolled.value) return;
  const next = Math.max(0, Math.min(stageDuration.value || Infinity, position));
  if (currentAudio.value) player.seek(next);
  else mediaSurface.value?.seekTo(next);
}
function seekStage(delta: number) { seekStageTo(stagePosition.value + delta); }

function clearStageControlsTimer() {
  if (stageControlsTimer !== undefined) clearTimeout(stageControlsTimer);
  stageControlsTimer = undefined;
}

function controlsHaveFocus() {
  const toolbar = page.value?.querySelector(".stage-toolbar");
  const active = document.activeElement;
  return active instanceof HTMLElement && !!toolbar?.contains(active) && active.matches(":focus-visible");
}

function scheduleStageControlsHide() {
  clearStageControlsTimer();
  stageControlsTimer = window.setTimeout(() => {
    stageControlsTimer = undefined;
    if (controlsHaveFocus()) return;
    stageControlsVisible.value = false;
  }, 3000);
}

function revealStageControls() {
  if (!stage.value) return;
  stageControlsVisible.value = true;
  scheduleStageControlsHide();
}

function onStageControlsFocusOut() {
  window.setTimeout(() => {
    if (stage.value && !controlsHaveFocus()) scheduleStageControlsHide();
  }, 0);
}

async function enterStage() {
  error.value = "";
  stageControlsVisible.value = false;
  clearStageControlsTimer();
  try {
    await page.value?.requestFullscreen();
    if (document.fullscreenElement !== page.value) throw new Error("Fullscreen unavailable");
    fullscreen.value = true;
    stage.value = true;
    page.value?.focus({ preventScroll: true });
  } catch {
    stage.value = false;
    fullscreen.value = false;
    error.value = t("ktv.fullscreenUnavailable");
  }
}

async function returnToPreparation() {
  if (document.fullscreenElement === page.value) await document.exitFullscreen().catch(() => {});
  onFullscreenChange();
}

async function toggleFullscreen() {
  if (document.fullscreenElement === page.value) await returnToPreparation();
  else await enterStage();
}

function onFullscreenChange() {
  fullscreen.value = document.fullscreenElement === page.value;
  stage.value = fullscreen.value;
  if (!stage.value) {
    stageControlsVisible.value = false;
    clearStageControlsTimer();
  }
}

function onStageKeydown(event: KeyboardEvent) {
  if (!stage.value || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Escape") { event.preventDefault(); void returnToPreparation(); return; }
  revealStageControls();
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))) return;
  if (event.code === "Space") { event.preventDefault(); void toggleStagePlayback(); }
  else if (event.key === "ArrowLeft") { event.preventDefault(); seekStage(-10); }
  else if (event.key === "ArrowRight") { event.preventDefault(); seekStage(10); }
  else if (event.key.toLowerCase() === "n") void perform({ action: "next", currentId: current.value?.id ?? null });
  else if (event.key.toLowerCase() === "q") showStageQr.value = !showStageQr.value;
  else if (event.key.toLowerCase() === "f") void toggleFullscreen();
  else if (event.key.toLowerCase() === "b") void returnToPreparation();
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
  clearStageControlsTimer();
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
  <div ref="page" class="ktv-page" :class="{ 'is-stage': stage }" :tabindex="stage ? -1 : undefined" @pointermove="revealStageControls" @pointerdown="revealStageControls">
    <header class="page-header ktv-header">
      <div>
        <div class="mono-label">EDGE SONIC / KARAOKE</div>
        <h1 class="page-title">{{ t("ktv.hostTitle") }}</h1>
        <p class="page-description">{{ t("ktv.intro") }}</p>
      </div>
      <button v-if="room" type="button" class="btn-danger btn-sm" @click="closeRoom">{{ t("ktv.closeRoom") }}</button>
      <button v-if="room && !stage" type="button" class="btn-primary btn-sm" @click="enterStage">{{ t("ktv.enterStage") }}</button>
    </header>

    <MediaAccountsCard v-if="!stage && settings.mediaMode === 'full'" />

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
            <p class="room-code">{{ t("ktv.roomCode") }} · <strong>{{ roomCode }}</strong></p>
            <h2>{{ t("ktv.participantCount", { count: room.participants.length }) }}</h2>
            <p class="feature-desc">{{ t("ktv.expires", { time: new Date(room.expiresAt > 1e12 ? room.expiresAt : room.expiresAt * 1000).toLocaleTimeString() }) }}</p>
            <input class="form-input invite-url" :value="fullInviteUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
            <button class="btn-secondary btn-sm" @click="copyInvite">{{ t("ktv.copyLink") }}</button>
            <button class="btn-secondary btn-sm" @click="perform({ action: 'rotate' })">{{ t("ktv.rotateLink") }}</button>
          </div>
          <img v-if="qrData" class="invite-qr" :src="qrData" :alt="t('ktv.joinQrAlt')" />
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
        <section class="card current-card" :class="{ 'with-lyrics': currentAudio }">
          <div v-if="stage && stageControlsVisible" class="stage-toolbar" role="toolbar" :aria-label="t('ktv.playbackControls')" @focusin="clearStageControlsTimer" @focusout="onStageControlsFocusOut">
            <label v-if="current && !iframeVideoUncontrolled" class="stage-seek">
              <span>{{ Math.floor(stagePosition / 60) }}:{{ String(Math.floor(stagePosition % 60)).padStart(2, '0') }}</span>
              <input type="range" min="0" step="0.1" :max="stageDuration || 1" :value="stagePosition" :disabled="stageDuration <= 0" :aria-label="t('ktv.seek')" @input="seekStageTo(Number(($event.target as HTMLInputElement).value))" />
              <span>{{ Math.floor(stageDuration / 60) }}:{{ String(Math.floor(stageDuration % 60)).padStart(2, '0') }}</span>
            </label>
            <button class="stage-icon" :aria-label="showStageQr ? t('ktv.hideQr') : t('ktv.showQr')" :title="showStageQr ? t('ktv.hideQr') : t('ktv.showQr')" :aria-pressed="showStageQr" @click="showStageQr = !showStageQr"><Icon name="qr" :size="20" /></button>
            <button class="stage-icon stage-play" :disabled="!current || iframeVideoUncontrolled" :aria-label="stagePlaying ? t('ktv.pause') : t('ktv.play')" :title="stagePlaying ? t('ktv.pause') : t('ktv.play')" @click="toggleStagePlayback"><Icon :name="stagePlaying ? 'pause' : 'play'" :size="22" /></button>
            <button class="stage-icon" :disabled="!canAdvance" :aria-label="t('ktv.next')" :title="t('ktv.next')" @click="perform({ action: 'next', currentId: current?.id ?? null })"><Icon name="next" :size="20" /></button>
            <button class="stage-icon" :aria-label="fullscreen ? t('ktv.exitFullscreen') : t('ktv.fullscreen')" :title="fullscreen ? t('ktv.exitFullscreen') : t('ktv.fullscreen')" @click="toggleFullscreen"><Icon :name="fullscreen ? 'minimize' : 'maximize'" :size="20" /></button>
          </div>
          <img v-if="stage && showStageQr && stageQrData" class="stage-qr-image" :style="{ '--qr-modules': qrModules }" tabindex="0" :src="stageQrData" :alt="t('ktv.joinQrAlt')" />
          <div class="mono-label stage-mode-label">{{ current ? t("ktv.status.playing") : t("ktv.chooseSource") }}</div>
          <div v-if="current" class="current-layout" :class="{ 'stage-audio-only': stage && currentAudio && !mediaSession }">
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
            <p v-if="!stage && iframeAudioMismatch" class="feature-desc" role="status">{{ t("ktv.iframeAudioMismatch") }}</p>
            <p v-else-if="!stage && iframeVideoUncontrolled" class="feature-desc" role="status">{{ t("ktv.iframeVideoUncontrolled") }}</p>
            <div class="current-copy">
              <div class="mono-label">{{ t("ktv.requester", { name: current.displayName }) }}</div>
              <h2>{{ current.title }}</h2>
              <p v-if="current.artist" class="feature-desc">{{ current.artist }}</p>
              <div class="current-actions">
                <button v-if="currentAudio" class="btn-secondary btn-sm" @click="player.toggle()">{{ player.playing ? t("ktv.pause") : t("ktv.play") }}</button>
                <button v-if="currentAudio" class="btn-secondary btn-sm" @click="perform({ action: 'next', currentId: current.id })">{{ t("ktv.next") }}</button>
                <button v-if="mediaSession && !current.audioId && !iframeTransport" class="btn-secondary btn-sm" :disabled="!listenOnly && !mediaSession.audioTracks.length" @click="toggleListenOnly">{{ listenOnly ? t("ktv.watchVideo") : t("ktv.listenOnly") }}</button>
                <button v-if="current.externalUrl && auth.hasPerm('upload')" class="btn-secondary btn-sm" :disabled="savingVideo || savedVideoItemId === current.id" @click="saveCurrentVideo">{{ savedVideoItemId === current.id ? t("videos.saved") : t("videos.save") }}</button>
                <p v-if="mediaSession && !current.audioId && !iframeTransport && !mediaSession.audioTracks.length" class="feature-desc">{{ t("media.audioTrackUnavailable") }}</p>
              </div>
              <label v-if="currentAudio && player.duration > 0" class="ktv-seek">
                <input type="range" min="0" step="0.1" :max="player.duration" :value="player.currentTime" @input="player.seek(Number(($event.target as HTMLInputElement).value))" />
                <span>{{ Math.floor(player.currentTime / 60) }}:{{ String(Math.floor(player.currentTime % 60)).padStart(2, '0') }} / {{ Math.floor(player.duration / 60) }}:{{ String(Math.floor(player.duration % 60)).padStart(2, '0') }}</span>
              </label>
            </div>
          </div>
          <div v-if="stage && currentAudio && !mediaSession" class="stage-audio-content">
            <strong>{{ current?.title }}</strong>
            <span v-if="current?.artist">{{ current.artist }}</span>
            <button v-if="!player.playing" type="button" class="btn-primary" @click="toggleStagePlayback">{{ t("ktv.play") }}</button>
          </div>
          <NowPlaying v-if="currentAudio && player.current?.id === current?.audioId" class="ktv-lyrics" />
          <div v-if="!current" class="empty-current">{{ t("ktv.emptyQueue") }}</div>

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
              <div class="result-actions"><button class="btn-secondary btn-sm" @click="enqueue({ videoId: video.id })">{{ t("ktv.addVideo") }}</button>
              <button v-if="selectedAudio" class="btn-secondary btn-sm" @click="addVideo(video)">{{ t("ktv.addPair") }}</button></div>
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
.room-code strong { font-size: 1.35rem; letter-spacing: .16em; font-variant-numeric: tabular-nums; }
.invite-qr { width: 160px; height: 160px; padding: 0; border: 0; border-radius: 0; }
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
.result-actions { display: flex; flex-wrap: wrap; gap: .4rem; }
.result-main { display: grid; min-width: 0; text-align: left; border: 0; color: inherit; background: transparent; cursor: pointer; }
.result-main strong, .search-result > strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-main small { color: var(--color-text-muted); }
.linked-choices { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; border-top: 1px solid var(--color-border-subtle); padding-top: .6rem; }
.linked-choices h3 { flex-basis: 100%; }
.error-text { color: var(--color-danger, #d13438); }
.ktv-error { margin: 0; }
.stage-toolbar, .stage-qr-image { display: none; }
.ktv-page.is-stage { position: fixed; inset: 0; z-index: 1200; display: block; width: 100vw; height: 100dvh; max-width: none; overflow: hidden; padding: 0; color: #fff; background: #050608; }
.is-stage > .ktv-header, .is-stage > .ktv-top-grid, .is-stage > .request-card, .is-stage > .ktv-error { display: none; }
.is-stage .ktv-main-grid { display: block; width: 100%; height: 100%; margin: 0 auto; max-width: none; }
.is-stage .queue-card { display: none; }
.is-stage .current-card { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden; border: 0; padding: .5rem 1rem; background: transparent; box-shadow: none; }
.is-stage .stage-mode-label, .is-stage .current-copy { display: none; }
.is-stage .current-layout.stage-audio-only { display: none; }
.is-stage .current-layout { display: flex; flex-direction: column; flex: 1 1 auto; align-items: center; justify-content: center; width: 100%; min-height: 0; max-width: none; margin: 0; }
.is-stage .current-layout :deep(.media-surface) { width: min(100%, calc((100dvh - 2rem) * 16 / 9)); height: auto; max-width: 100%; max-height: calc(100dvh - 2rem); min-height: 0; aspect-ratio: 16 / 9; margin: auto; }
.is-stage .current-card.with-lyrics .current-layout :deep(.media-surface) { width: min(100%, calc((100dvh - 260px) * 16 / 9)); max-height: calc(100dvh - 260px); }
.is-stage .current-layout :deep(.media-surface.audio-only) { width: min(100%, 900px); height: auto; min-height: 210px; }
.is-stage .stage-audio-content { display: grid; flex: 1 1 auto; align-content: center; justify-items: center; gap: .75rem; min-height: 0; padding: 1rem; text-align: center; }
.is-stage .stage-audio-content strong { font-size: clamp(1.4rem, 3vw, 2.4rem); }
.is-stage .stage-audio-content span { color: #bdc2ca; }
.is-stage .ktv-lyrics { flex: 0 0 min(24vh, 220px); width: min(100%, 1100px); height: min(24vh, 220px); min-height: 100px; margin: 0 auto; border: 0; }
.is-stage .ktv-lyrics :deep(.nowplaying) { height: 100%; }
.is-stage .stage-toolbar { position: fixed; z-index: 3; left: 50%; bottom: 1.25rem; width: min(560px, calc(100vw - 3rem)); transform: translateX(-50%); display: flex; justify-content: center; flex-wrap: wrap; gap: .5rem; padding: .75rem; border: 1px solid #ffffff26; border-radius: 16px; background: #15171dbd; box-shadow: 0 12px 40px #0005; backdrop-filter: blur(16px); }

.is-stage .stage-qr-image { position: fixed; display: block; z-index: 3; top: 1rem; right: 1rem; --qr-size: 176px; width: var(--qr-size); height: var(--qr-size); box-sizing: content-box; filter: blur(.45px); background: transparent; transition: padding .16s, background .16s, filter .16s; border: 0; border-radius: 0; padding: 0; box-shadow: none; pointer-events: auto; }
.is-stage .stage-qr-image:hover, .is-stage .stage-qr-image:focus-visible, .is-stage .stage-qr-image:active { padding: calc(var(--qr-size) * 4 / var(--qr-modules)); background: white; filter: none; outline: none; }
.stage-icon { display: grid; place-items: center; width: 38px; height: 38px; padding: 0; color: #e8ebef; border: 0; border-radius: 10px; background: transparent; cursor: pointer; }
.stage-icon:hover, .stage-icon:focus-visible { background: #ffffff20; }
.stage-icon[aria-pressed="false"], .stage-icon:disabled { opacity: .4; }
.stage-icon:disabled { cursor: default; }
.stage-play { background: #ffffff16; }
.stage-seek { display: flex; align-items: center; gap: .75rem; flex: 0 0 100%; font-size: .8rem; font-variant-numeric: tabular-nums; }
.stage-seek input { flex: 1; min-width: 0; accent-color: var(--color-accent-primary); cursor: pointer; }
.is-stage .empty-current { display: grid; flex: 1 1 auto; min-height: 0; }
@media (max-width: 850px) { .ktv-top-grid, .ktv-main-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 560px) { .invite-card { align-items: flex-start; } .invite-qr { width: 100px; height: 100px; } .search-columns { grid-template-columns: minmax(0, 1fr); } .comment-form, .external-row { flex-direction: column; } }
@media (max-width: 560px) { .is-stage .current-card { padding: .35rem .5rem; } .is-stage .stage-toolbar { bottom: 1rem; width: calc(100vw - 2.5rem); max-width: 440px; gap: .35rem; padding: .65rem; } .is-stage .stage-toolbar button { padding-inline: .55rem; }  .is-stage .stage-qr-image { top: .5rem; right: .5rem; --qr-size: 148px; } }
</style>
