<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import type { KtvAction, KtvComment, KtvRoomSnapshot } from "../../../shared/ktv";
import { getGuestKtvState, resolveKtvInvite, getParticipantKtvLinks, guestKtvAction, joinKtvRoom, openKtvSocket, participantStorageKey, searchKtvRoom, type KtvSearchAudio, type KtvSearchVideo, type KtvSearchExternal } from "../lib/ktvApi";
import { useAuth } from "../api";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const auth = useAuth();
let roomId = "";
const invite = typeof route.query.c === "string" ? route.query.c : "";
const enteredCode = ref(invite);
const room = ref<KtvRoomSnapshot | null>(null);
const participantId = ref("");
const participantToken = ref("");
const displayName = ref(auth.displayName.value || "");
const joined = ref(false);
const unavailable = ref(false);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const searchText = ref("");
const searchBusy = ref(false);
const searchProvider = ref<"library" | "youtube" | "bilibili">("library");
const externalResults = ref<KtvSearchExternal[]>([]);
const audioResults = ref<KtvSearchAudio[]>([]);
const videoResults = ref<KtvSearchVideo[]>([]);
const linkedVideos = ref<Array<{ videoId: string; videoTitle: string; offsetMs: number }>>([]);
const selectedAudio = ref<KtvSearchAudio | null>(null);
const externalUrl = ref("");
const listenOnly = ref(false);
const commentText = ref("");
const comments = ref<KtvComment[]>([]);
let socket: WebSocket | null = null;
let retryTimer: number | undefined;

const canRequest = computed(() => joined.value && !!room.value?.open && !unavailable.value);
const externalAllowed = computed(() => room.value?.mediaMode === "full" || room.value?.allowEmbeddedVideo);
const queue = computed(() => room.value?.queue ?? []);

function savedToken() {
  try { return sessionStorage.getItem(participantStorageKey(roomId)) || ""; }
  catch { return ""; }
}
function saveToken(token: string) {
  participantToken.value = token;
  sessionStorage.setItem(participantStorageKey(roomId), token);
}
function applyRoom(next: KtvRoomSnapshot) {
  if (!room.value || room.value.id !== next.id || next.version >= room.value.version) room.value = next;
}

function stopSocket() {
  const previous = socket;
  socket = null;
  previous?.close();
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
}
function connectSocket() {
  if (!canRequest.value || !participantToken.value) return;
  stopSocket();
  const connection = openKtvSocket(roomId, { kind: "participant", token: participantToken.value }, (raw) => {
    if (socket !== connection) return;
    const event = raw as { type?: string; room?: KtvRoomSnapshot; comment?: KtvComment };
    if (event.type === "state" && event.room) {
      applyRoom(event.room);
      if (!event.room.open) roomUnavailable();
    }
    if (event.type === "comment" && event.comment) comments.value = [...comments.value.slice(-99), event.comment];
    if (event.type === "closed") roomUnavailable();
  }, async () => {
    if (socket !== connection || !canRequest.value) return;
    try {
      const state = await getGuestKtvState(roomId, participantToken.value);
      if (socket !== connection) return;
      if (!state.room.open) { roomUnavailable(); return; }
      applyRoom(state.room);
    } catch (cause) {
      if (socket !== connection) return;
      if ([401, 403, 404, 410].includes((cause as { status?: number }).status || 0)) { roomUnavailable(); return; }
    }
    if (socket === connection && canRequest.value) retryTimer = window.setTimeout(connectSocket, 2500);
  });
  socket = connection;
}
function roomUnavailable() {
  unavailable.value = true;
  joined.value = false;
  room.value = null;
  sessionStorage.removeItem(participantStorageKey(roomId));
  stopSocket();
}

async function join() {
  if (!invite || !displayName.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await joinKtvRoom(roomId, { invite, displayName: displayName.value.trim(), ...(savedToken() ? { participantToken: savedToken() } : {}) });
    applyRoom(result.room);
    participantId.value = result.participantId;
    saveToken(result.participantToken);
    joined.value = true;
    sessionStorage.setItem(`edgesonic:ktv:name:${roomId}`, displayName.value.trim());
    connectSocket();
  } catch (cause) {
    const status = (cause as { status?: number }).status;
    if (status === 404 || status === 410) roomUnavailable();
    else error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable");
  } finally { busy.value = false; }
}

async function perform(action: KtvAction) {
  if (!canRequest.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await guestKtvAction(roomId, participantToken.value, action);
    applyRoom(result.room);
    return true;
  } catch (cause) {
    const status = (cause as { status?: number }).status;
    if (status === 404 || status === 410) roomUnavailable();
    else error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable");
  } finally { busy.value = false; }
}

async function search() {
  if (!canRequest.value || !searchText.value.trim()) return;
  searchBusy.value = true;
  try {
    const result = await searchKtvRoom(roomId, { kind: "participant", token: participantToken.value }, searchText.value.trim(), searchProvider.value);
    audioResults.value = result.audio;
    videoResults.value = result.videos;
    externalResults.value = result.external;
  } catch (cause) {
    if ([404, 410].includes((cause as { status?: number }).status || 0)) roomUnavailable();
    else error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable");
  } finally { searchBusy.value = false; }
}

async function selectAudio(audio: KtvSearchAudio) {
  selectedAudio.value = audio;
  linkedVideos.value = [];
  try {
    const result = await getParticipantKtvLinks(roomId, participantToken.value, audio.id);
    linkedVideos.value = result.links.map((link) => ({ videoId: link.videoId, videoTitle: link.videoTitle, offsetMs: link.offsetMs }));
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable"); }
}

async function requestExternal(url = externalUrl.value, bindAudio = true) {
  if (!url.trim() || !externalAllowed.value) return;
  const added = await perform({ action: "enqueue", selection: { audioId: bindAudio ? selectedAudio.value?.id : undefined, externalUrl: url.trim(), listenOnly: room.value?.mediaMode === "full" && !selectedAudio.value && listenOnly.value } });
  if (added) externalUrl.value = "";
}
function sendComment() {
  const text = commentText.value.trim();
  if (!text) return;
  commentText.value = "";
  void perform({ action: "comment", text });
}
function rename() {
  const name = displayName.value.trim();
  if (!name) return;
  sessionStorage.setItem(`edgesonic:ktv:name:${roomId}`, name);
  void perform({ action: "rename", displayName: name });
}
function canRemove(item: { participantId: string }) { return item.participantId === participantId.value; }

async function openRoom() {
  if (!invite) { loading.value = false; return; }
  try {
    const result = await resolveKtvInvite(invite);
    roomId = result.room.id;
    displayName.value = sessionStorage.getItem(`edgesonic:ktv:name:${roomId}`) || displayName.value;
    applyRoom(result.room);
    const token = savedToken();
    if (token) {
      try {
        const state = await getGuestKtvState(roomId, token);
        if (!state.room.open) { roomUnavailable(); return; }
        const display = displayName.value.trim() || auth.displayName.value || "Guest";
        const joinedResult = await joinKtvRoom(roomId, { invite, displayName: display, participantToken: token });
        applyRoom(joinedResult.room);
        participantId.value = joinedResult.participantId;
        saveToken(joinedResult.participantToken);
        joined.value = true;
        connectSocket();
      } catch (cause) {
        const status = (cause as { status?: number }).status;
        if (status === 404 || status === 410) roomUnavailable();
        else if (status === 401 || status === 403) sessionStorage.removeItem(participantStorageKey(roomId));
        else error.value = cause instanceof Error ? cause.message : t("ktv.serviceUnavailable");
      }
    }
  } catch (cause) {
    const status = (cause as { status?: number }).status;
    if (status === 404 || status === 410 || !invite) roomUnavailable();
    else error.value = cause instanceof Error ? cause.message : t("ktv.roomUnavailable");
  } finally { loading.value = false; }
}

function enterRoomCode() {
  const code = enteredCode.value.trim();
  if (!/^[0-9]{6}$/.test(code)) return;
  void router.replace({ path: "/k", query: { c: code } });
}

onMounted(() => { void openRoom(); });
onBeforeUnmount(stopSocket);
</script>

<template>
  <main class="guest-page">
    <header class="guest-header">
      <div class="mono-label">EDGE SONIC / KARAOKE</div>
      <h1>{{ t("ktv.hostTitle") }}</h1>
    </header>
    <section v-if="!invite || unavailable" class="guest-card">
      <form class="join-card" @submit.prevent="enterRoomCode">
        <label class="guest-field"><span>{{ t("ktv.roomCode") }}</span><input v-model="enteredCode" class="form-input room-code-input" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" :placeholder="t('ktv.roomCodePlaceholder')" /></label>
        <button class="btn-primary" :disabled="!/^[0-9]{6}$/.test(enteredCode.trim())">{{ t("ktv.openRoomCode") }}</button>
        <p v-if="unavailable" role="status">{{ t("ktv.roomUnavailable") }}</p>
      </form>
    </section>
    <section v-else-if="loading" class="guest-card"><p>{{ t("common.loading") }}</p></section>
    <section v-else-if="!room" class="guest-card unavailable" role="status">
      <h2>{{ t("ktv.roomUnavailable") }}</h2>
    </section>
    <template v-else>
      <section v-if="!joined" class="guest-card join-card">
        <p>{{ t("ktv.chooseSource") }}</p>
        <label class="guest-field"><span>{{ t("ktv.nickname") }}</span><input v-model="displayName" class="form-input" maxlength="32" /></label>
        <button class="btn-primary" :disabled="busy || !displayName.trim()" @click="join">{{ busy ? t("ktv.joining") : t("ktv.join") }}</button>
      </section>

      <template v-else-if="canRequest">
        <section class="guest-card">
          <div class="guest-room-head">
            <div><div class="mono-label">{{ t("ktv.queue") }} · {{ room.mode === 'fair' ? t("ktv.fair") : t("ktv.fifo") }}</div><h2>{{ room.current?.title || t("ktv.emptyQueue") }}</h2></div>
            <span class="participant-count">{{ room.participants.length }}</span>
          </div>
          <form class="rename-row" @submit.prevent="rename">
            <input v-model="displayName" class="form-input" maxlength="32" :placeholder="t('ktv.nickname')" />
            <button class="btn-secondary btn-sm" :disabled="busy || !displayName.trim()">{{ t("ktv.rename") }}</button>
          </form>
          <ol class="guest-queue">
            <li v-for="item in queue" :key="item.id">
              <div><strong>{{ item.title }}</strong><small>{{ t("ktv.requester", { name: item.displayName }) }}</small></div>
              <span class="queue-status">{{ t(`ktv.status.${item.status}`) }}</span>
              <button v-if="canRemove(item)" class="btn-secondary btn-sm" :disabled="busy" @click="perform({ action: 'remove', itemId: item.id })">{{ t("ktv.remove") }}</button>
            </li>
          </ol>
          <div class="comment-section">
            <div class="mono-label">{{ t("ktv.comments") }}</div>
            <p v-for="comment in comments.slice(-4)" :key="comment.id"><strong>{{ comment.displayName }}:</strong> {{ comment.text }}</p>
            <form class="comment-form" @submit.prevent="sendComment">
              <input v-model="commentText" class="form-input" maxlength="120" :placeholder="t('ktv.commentPlaceholder')" />
              <button class="btn-secondary btn-sm" :disabled="busy || !commentText.trim()">{{ t("ktv.sendComment") }}</button>
            </form>
          </div>
        </section>

        <section class="guest-card request-card">
          <div class="mono-label">{{ t("ktv.search") }}</div>
          <select v-if="room.mediaMode === 'full'" v-model="searchProvider" class="form-input" :aria-label="t('ktv.searchSource')">
            <option value="library">{{ t("ktv.librarySource") }}</option><option value="bilibili">Bilibili</option><option value="youtube">YouTube</option>
          </select>
          <form class="search-row" @submit.prevent="search">
            <input v-model="searchText" class="form-input" :placeholder="t('ktv.searchPlaceholder')" />
            <button class="btn-primary" :disabled="searchBusy || !searchText.trim()">{{ t("ktv.searchButton") }}</button>
          </form>
          <p v-if="searchBusy">{{ t("common.loading") }}</p>
          <div v-if="audioResults.length" class="result-group">
            <h3>{{ t("ktv.audio") }}</h3>
            <div v-for="audio in audioResults" :key="audio.id" class="result-row">
              <button class="result-copy" @click="selectAudio(audio)"><strong>{{ audio.title }}</strong><small>{{ audio.artist }}</small></button>
              <button class="btn-secondary btn-sm" @click="perform({ action: 'enqueue', selection: { audioId: audio.id } })">{{ t("ktv.addAudio") }}</button>
            </div>
          </div>
          <div v-if="videoResults.length" class="result-group">
            <h3>{{ t("ktv.video") }}</h3>
            <div v-for="video in videoResults" :key="video.id" class="result-row">
              <strong>{{ video.title }}</strong>
              <div class="result-actions">
                <button class="btn-secondary btn-sm" @click="perform({ action: 'enqueue', selection: { videoId: video.id, listenOnly: room.mediaMode === 'full' && listenOnly } })">{{ t("ktv.addVideo") }}</button>
                <button v-if="selectedAudio" class="btn-secondary btn-sm" @click="perform({ action: 'enqueue', selection: { audioId: selectedAudio.id, videoId: video.id } })">{{ t("ktv.addPair") }}</button>
              </div>
            </div>
          </div>
          <div v-for="video in externalResults" :key="video.url" class="result-row">
            <strong>{{ video.title }}</strong><div class="result-actions">
              <button class="btn-secondary btn-sm" :disabled="busy" @click="requestExternal(video.url, false)">{{ t("ktv.addVideo") }}</button>
              <button v-if="selectedAudio" class="btn-secondary btn-sm" :disabled="busy" @click="requestExternal(video.url)">{{ t("ktv.addPair") }}</button>
            </div>
          </div>
          <div v-if="selectedAudio" class="linked-row">
            <h3>{{ t("ktv.boundAudio") }} · {{ selectedAudio.title }}</h3>
            <button class="btn-secondary btn-sm" @click="selectedAudio = null; linkedVideos = []">{{ t("common.clear") }}</button>
            <button v-for="video in linkedVideos" :key="video.videoId" class="btn-secondary btn-sm" @click="perform({ action: 'enqueue', selection: { audioId: selectedAudio?.id, videoId: video.videoId, offsetMs: video.offsetMs } })">{{ video.videoTitle }} · {{ t("ktv.addPair") }}</button>
          </div>
          <form v-if="externalAllowed" class="external-row" @submit.prevent="requestExternal()">
            <input v-model="externalUrl" class="form-input" :placeholder="t('ktv.externalPlaceholder')" />
            <button class="btn-secondary" :disabled="busy || !externalUrl.trim()">{{ t("ktv.requestExternal") }}</button>
          </form>
          <p v-if="room.mediaMode === 'compatible'" class="compatibility-hint">{{ room.allowEmbeddedVideo ? t('settings.ktv.compatibilityHint') : t('settings.ktv.compatibilityDisabled') }}</p>
          <label v-if="!selectedAudio && room.mediaMode === 'full'" class="listen-option"><input v-model="listenOnly" type="checkbox" />{{ t("ktv.listenOnly") }}</label>
        </section>
      </template>
    </template>
    <p v-if="error && !unavailable" class="guest-error" role="alert">{{ error }}</p>
  </main>
</template>

<style scoped>
.guest-page { min-height: 100vh; padding: clamp(1rem, 4vw, 2.5rem); color: var(--color-text-primary); background: var(--color-bg-primary); }
.guest-header, .guest-card { width: min(100%, 760px); margin: 0 auto 1rem; }
.guest-header h1 { margin: .35rem 0 1rem; font-size: clamp(1.45rem, 5vw, 2.2rem); }
.guest-card { padding: 1rem; border: 1px solid var(--color-border-subtle); border-radius: 16px; background: var(--color-bg-secondary); box-shadow: 0 12px 40px #0002; }
.join-card { display: grid; gap: .85rem; }
.guest-field { display: grid; gap: .4rem; }
.guest-room-head { display: flex; justify-content: space-between; gap: .75rem; align-items: flex-start; }
.guest-room-head h2 { margin: .35rem 0; font-size: 1.2rem; }
.participant-count { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 50%; background: var(--color-bg-tertiary); }
.rename-row, .search-row, .comment-form, .external-row { display: flex; gap: .5rem; margin-top: .7rem; }
.rename-row input, .search-row input, .comment-form input, .external-row input { min-width: 0; flex: 1; }
.guest-queue { display: grid; gap: .4rem; list-style: none; padding: 0; max-height: 300px; overflow: auto; }
.guest-queue li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: .45rem; border-top: 1px solid var(--color-border-subtle); padding: .55rem 0; }
.guest-queue small, .result-copy small { display: block; color: var(--color-text-muted); margin-top: .2rem; }
.queue-status { color: var(--color-text-muted); font-size: .8rem; }
.comment-section, .result-group, .linked-row { margin-top: .85rem; padding-top: .7rem; border-top: 1px solid var(--color-border-subtle); }
.comment-section p { margin: .35rem 0; font-size: .9rem; }
.result-group h3, .linked-row h3 { margin: 0 0 .5rem; font-size: .95rem; }
.result-row { display: flex; justify-content: space-between; gap: .5rem; align-items: center; padding: .5rem 0; border-top: 1px solid var(--color-border-subtle); }
.result-copy { color: inherit; text-align: left; border: 0; background: transparent; cursor: pointer; }
.result-copy strong, .result-row > strong { overflow-wrap: anywhere; }
.result-actions { display: flex; align-items: center; gap: .5rem; }
.compatibility-hint { color: var(--color-text-muted); font-size: .85rem; }
.listen-option { display: flex; align-items: center; gap: .25rem; font-size: .72rem; color: var(--color-text-muted); }
.linked-row { display: flex; flex-wrap: wrap; gap: .45rem; }
.linked-row h3 { flex-basis: 100%; }
.unavailable { text-align: center; padding: 2rem 1rem; }
.guest-error { width: min(100%,760px); margin: 0 auto; color: var(--color-danger, #d13438); }
@media (max-width: 520px) { .guest-page { padding: .75rem; } .guest-queue li { grid-template-columns: 1fr auto; } .queue-status { display: none; } .result-row { align-items: flex-start; flex-direction: column; } .result-actions { width: 100%; justify-content: space-between; } .rename-row, .search-row, .comment-form, .external-row { flex-direction: column; } }
</style>
