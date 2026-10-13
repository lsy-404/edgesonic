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
import { getVideoPlayback, resolveExternalVideo, type MediaSession } from "../lib/videoApi";

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
const mediaError = ref("");
const autoplayBlocked = ref(false);
const mediaTime = ref(0);
const mediaDuration = ref(0);
const mediaPlaying = ref(false);
const listenOnly = ref(false);
const mediaLoading = ref(false);
const playerSnapshotKey = "edgesonic:ktv:previous-player";
let socket: WebSocket | null = null;
let heartbeatTimer: number | undefined;
let playbackTimer: number | undefined;
let socketRetryTimer: number | undefined;
let lastFinishedId = "";
let itemGeneration = 0;

const current = computed(() => room.value?.current ?? null);
const currentAudio = computed(() => !!current.value?.audioId && !listenOnly.value);
const canAdvance = computed(() => room.value?.queue[0]?.status === "queued");
const linkedOffset = computed(() => current.value?.offsetMs ?? 0);
const activeComments = computed(() => comments.value.filter((item) => !current.value || item.itemId === current.value.id));
const fullInviteUrl = computed(() => new URL(inviteUrl.value, window.location.href).toString());

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
  socket?.close();
  socket = null;
  if (socketRetryTimer !== undefined) clearTimeout(socketRetryTimer);
  socketRetryTimer = undefined;
}

function connectSocket() {
  if (!roomId.value || !controllerToken.value || !room.value?.open) return;
  stopSocket();
  socket = openKtvSocket(roomId.value, { kind: "controller", token: controllerToken.value }, (raw) => {
    const event = raw as { type?: string; room?: KtvRoomSnapshot; comment?: KtvComment };
    if (event.type === "state" && event.room) room.value = event.room;
    if (event.type === "comment" && event.comment) comments.value.push(event.comment);
    if (event.type === "closed") handleClosed();
  }, () => {
    if (room.value?.open && !document.hidden) socketRetryTimer = window.setTimeout(connectSocket, 2500);
  });
}

function startHeartbeat() {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    if (!room.value?.open || document.hidden) return;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: "heartbeat" }));
    else void perform({ action: "heartbeat" }, false);
  }, 20_000);
  if (playbackTimer !== undefined) clearInterval(playbackTimer);
  playbackTimer = window.setInterval(() => {
    if (!room.value?.open || !room.value.current || document.hidden) return;
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
  await perform({ action: "close" });
  handleClosed();
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
  error.value = t("ktv.roomUnavailable");
}

async function copyInvite() {
  try { await navigator.clipboard.writeText(new URL(inviteUrl.value, location.href).toString()); }
  catch { error.value = "Copy failed. Select the request link to copy it."; }
}

async function search() {
  if (!room.value || !searchText.value.trim()) return;
  searchBusy.value = true;
  error.value = "";
  selectedAudio.value = null;
  linkedVideos.value = [];
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
function addVideo(video: KtvSearchVideo) { void enqueue({ videoId: video.id }); }
function normalizeExternal(value: string) {
  const clean = value.trim();
  if (/^BV[0-9A-Za-z]+$/.test(clean)) return `https://www.bilibili.com/video/${clean}`;
  if (/^av\d+$/i.test(clean)) return `https://www.bilibili.com/video/${clean}`;
  return clean;
}
function requestExternal() {
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
  listenOnly.value = item?.listenOnly === true;
  mediaTime.value = 0;
  mediaDuration.value = item?.duration ?? 0;
  mediaPlaying.value = false;
  if (!item) return;
  if (item.audioId && !item.listenOnly) {
    if (player.current?.id !== item.audioId) {
      player.setQueue([{ id: item.audioId, title: item.title, artist: item.artist || "", album: "", duration: item.duration ?? 0 }]);
    } else if (!player.playing) player.toggle();
  } else if (player.playing) player.toggle();
  if (!item.videoId && !item.externalUrl) return;
  mediaLoading.value = true;
  try {
    const result = item.videoId ? await getVideoPlayback(item.videoId) : await resolveExternalVideo(item.externalUrl!);
    if (generation !== itemGeneration) return;
    mediaSession.value = result.session;
    mediaDuration.value = result.session.duration ?? item.duration ?? 0;
  } catch (cause) {
    if (generation === itemGeneration) mediaError.value = cause instanceof Error ? cause.message : t("ktv.playbackError");
  } finally { if (generation === itemGeneration) mediaLoading.value = false; }
}

watch(() => room.value?.current?.id, () => { void loadCurrentMedia(current.value); }, { immediate: true });
watch(() => player.endedSequence, (sequence, previous) => {
  if (sequence === previous || !current.value?.audioId || current.value.listenOnly || current.value.id === lastFinishedId) return;
  lastFinishedId = current.value.id;
  void perform({ action: "next", currentId: current.value.id });
});

function updateMediaClock(time: number) { mediaTime.value = time; }
function updateMediaPlaying(value: boolean) { mediaPlaying.value = value; }
function videoSyncTime() { return player.currentTime + linkedOffset.value / 1000; }
function toggleListenOnly() {
  if (!current.value?.videoId && !current.value?.externalUrl) return;
  const switchingToListen = !listenOnly.value;
  if (switchingToListen && current.value.audioId) {
    mediaTime.value = player.currentTime + linkedOffset.value / 1000;
    if (player.playing) player.toggle();
  } else if (!switchingToListen && current.value.audioId) {
    player.seek(Math.max(0, mediaTime.value - linkedOffset.value / 1000));
    player.toggle();
  }
  listenOnly.value = switchingToListen;
}

function onVisibilityChange() {
  if (document.hidden) return;
  if (room.value?.open && (!socket || socket.readyState > WebSocket.OPEN)) connectSocket();
}

onMounted(async () => {
  await settings.load();
  if (settings.enabled) {
    if (sessionStorage.getItem(hostStorageKey)) savePreviousPlayer();
    await recoverRoom();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stopSocket();
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  if (playbackTimer !== undefined) clearInterval(playbackTimer);
  if (player.playing && currentAudio.value) player.toggle();
});
</script>

<template>
  <div class="ktv-page">
    <header class="page-header ktv-header">
      <div>
        <div class="mono-label">EDGE SONIC / KTV</div>
        <h1 class="page-title">{{ t("ktv.hostTitle") }}</h1>
        <p class="page-description">{{ t("ktv.intro") }}</p>
      </div>
      <button v-if="room" type="button" class="btn-danger btn-sm" @click="closeRoom">{{ t("ktv.closeRoom") }}</button>
    </header>

    <div v-if="!settings.enabled" class="card ktv-notice">
      <p>{{ t("ktv.disabled") }}</p>
      <router-link class="btn-primary" to="/settings">{{ t("ktv.openSettings") }}</router-link>
    </div>

    <div v-else-if="!room" class="card ktv-start-card">
      <label class="form-row">
        <span class="tc-key">{{ t("ktv.nickname") }}</span>
        <input v-model="displayName" class="form-input" maxlength="48" />
      </label>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
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
            <input v-model="displayName" class="form-input" maxlength="48" :placeholder="t('ktv.nickname')" />
            <button class="btn-secondary btn-sm" :disabled="!displayName.trim()">{{ t("ktv.rename") }}</button>
          </form>
        </section>
      </div>

      <div class="ktv-main-grid">
        <section class="card current-card">
          <div class="mono-label">{{ current ? t("ktv.status.playing") : t("ktv.chooseSource") }}</div>
          <div v-if="current" class="current-layout">
            <MediaSurface
              v-if="mediaSession"
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
              @ended="currentAudio ? undefined : perform({ action: 'next', currentId: current.id })"
              @error="mediaError = $event"
              @autoplay-blocked="autoplayBlocked = true"
            />
            <div v-else-if="mediaLoading" class="media-placeholder">{{ t("common.loading") }}</div>
            <p v-if="mediaError" class="error-text" role="alert">{{ mediaError }}</p>
            <p v-if="autoplayBlocked" class="feature-desc" role="status">{{ t("ktv.autoplayBlocked") }}</p>
            <div class="current-copy">
              <div class="mono-label">{{ t("ktv.requester", { name: current.displayName }) }}</div>
              <h2>{{ current.title }}</h2>
              <p v-if="current.artist" class="feature-desc">{{ current.artist }}</p>
              <div class="current-actions">
                <button v-if="currentAudio" class="btn-secondary btn-sm" @click="player.toggle()">{{ player.playing ? t("ktv.pause") : t("ktv.play") }}</button>
                <button v-if="currentAudio" class="btn-secondary btn-sm" @click="perform({ action: 'next', currentId: current.id })">{{ t("ktv.next") }}</button>
                <button v-if="mediaSession && !current.audioId" class="btn-secondary btn-sm" :disabled="!listenOnly && !mediaSession.audioTracks.length" @click="toggleListenOnly">{{ listenOnly ? t("ktv.watchVideo") : t("ktv.listenOnly") }}</button>
                <p v-if="mediaSession && !current.audioId && !mediaSession.audioTracks.length" class="feature-desc">{{ t("media.audioTrackUnavailable") }}</p>
              </div>
              <label v-if="currentAudio && player.duration > 0" class="ktv-seek">
                <input type="range" min="0" :max="player.duration" :value="player.currentTime" @input="player.seek(Number(($event.target as HTMLInputElement).value))" />
                <span>{{ Math.floor(player.currentTime / 60) }}:{{ String(Math.floor(player.currentTime % 60)).padStart(2, '0') }} / {{ Math.floor(player.duration / 60) }}:{{ String(Math.floor(player.duration % 60)).padStart(2, '0') }}</span>
              </label>
            </div>
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
              <input v-model="commentText" class="form-input" maxlength="240" :placeholder="t('ktv.commentPlaceholder')" />
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
              <button class="btn-secondary btn-sm" @click="addVideo(video)">{{ t("ktv.addVideo") }}</button>
            </div>
          </div>
        </div>
        <div v-if="linkedVideos.length" class="linked-choices">
          <h3>{{ t("ktv.linkAudioVideo") }} · {{ selectedAudio?.title }}</h3>
          <button v-for="video in linkedVideos" :key="video.videoId" class="btn-secondary btn-sm" @click="enqueue({ audioId: selectedAudio?.id, videoId: video.videoId, offsetMs: video.offsetMs })">{{ video.videoTitle }} · {{ t("ktv.addPair") }}</button>
        </div>
        <form class="external-row" @submit.prevent="requestExternal">
          <input v-model="externalUrl" class="form-input" :placeholder="t('ktv.externalPlaceholder')" />
          <button class="btn-secondary" :disabled="!externalUrl.trim()">{{ t("ktv.requestExternal") }}</button>
        </form>
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
@media (max-width: 850px) { .ktv-top-grid, .ktv-main-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 560px) { .invite-card { align-items: flex-start; } .invite-qr { width: 100px; height: 100px; } .search-columns { grid-template-columns: minmax(0, 1fr); } .comment-form, .external-row { flex-direction: column; } }
</style>
