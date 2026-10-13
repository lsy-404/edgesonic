<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useAuth, parseXmlAttrs } from "../api";
import Icon from "../components/Icon.vue";
import MediaSurface from "../components/MediaSurface.vue";
import { getVideoPlayback, importVideoFile, listVideoLinks, listVideos, removeVideoLink, resolveExternalVideo, saveExternalVideo, saveVideoLink, type MediaSession, type VideoAudioLink, type VideoSummary } from "../lib/videoApi";

interface AudioHit { id: string; title: string; artist: string }
interface StorageSource { id: string; name: string }

const { t } = useI18n();
const auth = useAuth();
const router = useRouter();
const query = ref("");
const videos = ref<VideoSummary[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const error = ref("");
const selectedVideo = ref<VideoSummary | null>(null);
const session = ref<MediaSession | null>(null);
const previewAudioOnly = ref(false);
const mediaTime = ref(0);
const mediaPlaying = ref(false);
const externalUrl = ref("");
const saveBusy = ref(false);
const importSourceId = ref("r2");
const importPath = ref("");
const importBusy = ref(false);
const sources = ref<StorageSource[]>([]);
const links = ref<VideoAudioLink[]>([]);
const audioQuery = ref("");
const audioHits = ref<AudioHit[]>([]);
const audioBusy = ref(false);
const offsetMs = ref(0);
const linkBusyId = ref("");
const pageSize = 40;

const canLoadMore = computed(() => offset.value + videos.value.length < total.value);
const selectedLinks = computed(() => links.value.filter((link) => link.videoId === selectedVideo.value?.id));

async function loadVideos(reset = true) {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  const start = reset ? 0 : offset.value + videos.value.length;
  try {
    const result = await listVideos(query.value.trim(), start, pageSize);
    videos.value = reset ? result.videos : [...videos.value, ...result.videos];
    offset.value = start;
    total.value = result.total;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Video library is unavailable."; }
  finally { loading.value = false; }
}
function submitVideoSearch() { void loadVideos(true); }

async function loadLinks(video: VideoSummary) {
  selectedVideo.value = video;
  links.value = [];
  audioHits.value = [];
  audioQuery.value = "";
  try {
    const result = await listVideoLinks({ videoId: video.id });
    links.value = result.links;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Video links could not be loaded."; }
}

async function playVideo(video: VideoSummary, audioOnly = false) {
  selectedVideo.value = video;
  previewAudioOnly.value = audioOnly;
  error.value = "";
  try {
    const result = await getVideoPlayback(video.id);
    session.value = result.session;
    mediaTime.value = 0;
    mediaPlaying.value = false;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Video playback is unavailable."; }
}

async function resolveTemporary() {
  if (!externalUrl.value.trim()) return;
  error.value = "";
  try {
    const result = await resolveExternalVideo(externalUrl.value.trim());
    selectedVideo.value = null;
    session.value = result.session;
    previewAudioOnly.value = false;
    mediaTime.value = 0;
    mediaPlaying.value = false;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "This video could not be prepared."; }
}

async function saveExternal() {
  if (!externalUrl.value.trim()) return;
  saveBusy.value = true;
  error.value = "";
  try {
    const result = await saveExternalVideo(externalUrl.value.trim());
    externalUrl.value = "";
    await loadVideos();
    await loadLinks(result.video);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t("videos.saveFailed"); }
  finally { saveBusy.value = false; }
}

async function importFile() {
  if (!importSourceId.value.trim() || !importPath.value.trim()) return;
  importBusy.value = true;
  error.value = "";
  try {
    const result = await importVideoFile(importSourceId.value.trim(), importPath.value.trim());
    importPath.value = "";
    await loadVideos();
    await loadLinks(result.video);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "This file could not be imported."; }
  finally { importBusy.value = false; }
}

async function loadSources() {
  try {
    const xml = await auth.storageFetch("sources/list");
    sources.value = parseXmlAttrs(xml, "source")
      .filter((source) => source.enabled === "true" || source.enabled === "1")
      .map((source) => ({ id: source.id || "", name: source.name || source.id || "" }))
      .filter((source) => source.id);
  } catch { sources.value = [{ id: "r2", name: "R2" }]; }
  if (!sources.value.some((source) => source.id === importSourceId.value) && sources.value[0]) importSourceId.value = sources.value[0].id;
}

async function searchAudio() {
  if (!audioQuery.value.trim()) return;
  audioBusy.value = true;
  try {
    const xml = await auth.authFetch("search3", {
      query: audioQuery.value.trim(), artistCount: "0", artistOffset: "0", albumCount: "0", albumOffset: "0", songCount: "20", songOffset: "0",
    });
    audioHits.value = parseXmlAttrs(xml, "song").map((song) => ({ id: song.id || "", title: song.title || "", artist: song.artist || "" })).filter((song) => song.id);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Audio search is unavailable."; }
  finally { audioBusy.value = false; }
}

async function attachAudio(audio: AudioHit) {
  if (!selectedVideo.value) return;
  linkBusyId.value = audio.id;
  try {
    await saveVideoLink(selectedVideo.value.id, audio.id, Math.round(offsetMs.value));
    await loadLinks(selectedVideo.value);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "The audio link could not be saved."; }
  finally { linkBusyId.value = ""; }
}

async function detachAudio(link: VideoAudioLink) {
  linkBusyId.value = link.audioId;
  try {
    await removeVideoLink(link.videoId, link.audioId);
    links.value = links.value.filter((item) => item.audioId !== link.audioId || item.videoId !== link.videoId);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "The audio link could not be removed."; }
  finally { linkBusyId.value = ""; }
}

async function updateOffset(link: VideoAudioLink) {
  linkBusyId.value = link.audioId;
  try { await saveVideoLink(link.videoId, link.audioId, Math.round(link.offsetMs)); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "The video offset could not be saved."; }
  finally { linkBusyId.value = ""; }
}

function useFilePage() { void router.push({ path: "/files", query: { source: importSourceId.value } }); }
function videoProvider(provider: VideoSummary["provider"]) { return provider === "file" ? "FILE" : provider === "youtube" ? "YOUTUBE" : "BILIBILI"; }
watch(query, () => { void loadVideos(); });
onMounted(() => { void loadSources(); void loadVideos(); });
</script>

<template>
  <div class="video-library-page">
    <header class="page-header video-header">
      <div>
        <div class="mono-label">EDGE SONIC / VIDEO</div>
        <h1 class="page-title">{{ t("videos.title") }}</h1>
        <p class="page-description">{{ t("videos.intro") }}</p>
      </div>
      <router-link class="btn-secondary btn-sm" :to="{ path: '/files', query: { source: importSourceId } }">{{ t("videos.fileImport") }}</router-link>
    </header>

    <section class="card source-tools">
      <form class="external-form" @submit.prevent="saveExternal">
        <label class="field-grow"><span class="mono-label">{{ t("videos.saveExternal") }}</span><input v-model="externalUrl" class="form-input" :placeholder="t('videos.externalPlaceholder')" /></label>
        <button class="btn-primary" :disabled="saveBusy || !externalUrl.trim()">{{ saveBusy ? t("common.loading") : t("videos.save") }}</button>
        <button type="button" class="btn-secondary" :disabled="!externalUrl.trim()" @click="resolveTemporary">{{ t("videos.preview") }}</button>
      </form>
      <form class="import-form" @submit.prevent="importFile">
        <div class="import-title">
          <div><div class="mono-label">{{ t("videos.fileImport") }}</div><p class="feature-desc">{{ t("videos.fileImportHint") }}</p></div>
          <button type="button" class="btn-secondary btn-sm" @click="useFilePage">{{ t("app.menu.files") }}</button>
        </div>
        <label class="import-field"><span>{{ t("videos.sourceId") }}</span><select v-model="importSourceId" class="form-input"><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }} · {{ source.id }}</option></select></label>
        <label class="import-field"><span>{{ t("videos.path") }}</span><input v-model="importPath" class="form-input" placeholder="videos/example.mp4" /></label>
        <button class="btn-secondary btn-sm" :disabled="importBusy || !importSourceId || !importPath.trim()">{{ importBusy ? t("common.loading") : t("videos.import") }}</button>
      </form>
    </section>

    <div class="video-content-grid">
      <section class="video-list-column">
        <form class="video-search" @submit.prevent="submitVideoSearch">
          <input v-model="query" class="form-input" :placeholder="t('videos.searchPlaceholder')" />
          <button class="btn-secondary" :disabled="loading">{{ t("videos.search") }}</button>
        </form>
        <p v-if="loading && !videos.length" class="feature-desc">{{ t("common.loading") }}</p>
        <p v-else-if="!videos.length" class="feature-desc empty-videos">{{ t("videos.empty") }}</p>
        <div class="video-list">
          <article v-for="video in videos" :key="video.id" class="video-card" :class="{ selected: selectedVideo?.id === video.id }">
            <button class="video-card-main" @click="loadLinks(video)">
              <span class="video-provider">{{ videoProvider(video.provider) }}</span>
              <strong>{{ video.title }}</strong>
              <small>{{ video.duration ? `${Math.floor(video.duration / 60)}:${String(Math.floor(video.duration % 60)).padStart(2, '0')}` : "—" }}<template v-if="video.width && video.height"> · {{ video.width }}×{{ video.height }}</template></small>
            </button>
            <div class="video-card-actions">
              <button class="btn-secondary btn-sm" @click="playVideo(video)">{{ t("videos.watch") }}</button>
              <button class="btn-secondary btn-sm" @click="playVideo(video, true)">{{ t("videos.listen") }}</button>
            </div>
          </article>
        </div>
        <button v-if="canLoadMore" class="btn-secondary load-more" :disabled="loading" @click="loadVideos(false)">{{ loading ? t("common.loading") : t("app.more") }}</button>
      </section>

      <aside class="video-detail-column">
        <section v-if="session" class="card preview-card">
          <div class="preview-heading">
            <div><div class="mono-label">{{ t("videos.preview") }}</div><h2>{{ session.title }}</h2></div>
            <button class="btn-secondary btn-sm" :disabled="!previewAudioOnly && !session.audioTracks.length" @click="previewAudioOnly = !previewAudioOnly">{{ previewAudioOnly ? t("videos.watch") : t("videos.listen") }}</button>
          </div>
          <MediaSurface :session="session" :audio-only="previewAudioOnly" :initial-time="mediaTime" :start-playing="mediaPlaying" @time="mediaTime = $event" @playing="mediaPlaying = $event" @error="error = $event" @autoplay-blocked="mediaPlaying = false" />
          <p v-if="!session.audioTracks.length" class="feature-desc">{{ t("media.audioTrackUnavailable") }}</p>
        </section>

        <section class="card links-card">
          <div class="mono-label">{{ t("videos.manageLinks") }}</div>
          <h2>{{ selectedVideo?.title || t("videos.title") }}</h2>
          <p v-if="!selectedVideo" class="feature-desc">{{ t("videos.noneLinked") }}</p>
          <template v-else>
            <div class="linked-audio">
              <div v-for="link in selectedLinks" :key="link.audioId" class="audio-link-row">
                <span><strong>{{ link.audioTitle }}</strong></span>
                <label class="offset-editor"><span>{{ t("videos.offset") }}</span><input v-model.number="link.offsetMs" class="form-input" type="number" step="10" /></label>
                <button class="btn-secondary btn-sm" :disabled="linkBusyId === link.audioId" @click="updateOffset(link)">{{ t("common.save") }}</button>
                <button class="btn-secondary btn-sm" :disabled="linkBusyId === link.audioId" @click="detachAudio(link)">{{ t("videos.removeLink") }}</button>
              </div>
              <p v-if="!selectedLinks.length" class="feature-desc">{{ t("videos.noneLinked") }}</p>
            </div>
            <form class="audio-search-form" @submit.prevent="searchAudio">
              <label><span class="mono-label">{{ t("videos.audioSearch") }}</span><input v-model="audioQuery" class="form-input" :placeholder="t('videos.audioPlaceholder')" /></label>
              <label><span class="tc-key">{{ t("videos.offset") }}</span><input v-model.number="offsetMs" class="form-input" type="number" step="10" /></label>
              <button class="btn-secondary btn-sm" :disabled="audioBusy || !audioQuery.trim()">{{ audioBusy ? t("common.loading") : t("videos.search") }}</button>
            </form>
            <div class="audio-hits">
              <button v-for="audio in audioHits" :key="audio.id" class="audio-hit" :disabled="linkBusyId === audio.id || selectedLinks.some((link) => link.audioId === audio.id)" @click="attachAudio(audio)">
                <span><strong>{{ audio.title }}</strong><small>{{ audio.artist }}</small></span><span>{{ t("videos.addLink") }}</span>
              </button>
            </div>
          </template>
        </section>
      </aside>
    </div>
    <p v-if="error" class="video-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.video-library-page { display: grid; gap: 1rem; max-width: 1440px; margin: 0 auto; }
.video-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; }
.card { padding: 1rem; }
.source-tools { display: grid; gap: 1rem; }
.external-form { display: flex; align-items: flex-end; gap: .5rem; }
.field-grow { flex: 1; min-width: 0; display: grid; gap: .4rem; }
.import-form { display: grid; grid-template-columns: 1.25fr 1fr minmax(180px, 1fr) auto; align-items: end; gap: .65rem; border-top: 1px solid var(--color-border-subtle); padding-top: .8rem; }
.import-title { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.import-title p { margin: .25rem 0 0; }
.import-field { display: grid; gap: .35rem; font-size: .82rem; color: var(--color-text-muted); }
.video-content-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(330px, .95fr); gap: 1rem; align-items: start; }
.video-list-column, .video-detail-column { min-width: 0; display: grid; gap: .75rem; }
.video-search { display: flex; gap: .5rem; }
.video-search input { min-width: 0; flex: 1; }
.video-list { display: grid; gap: .55rem; }
.video-card { display: flex; justify-content: space-between; align-items: center; gap: .7rem; padding: .75rem; border: 1px solid var(--color-border-subtle); border-radius: 12px; background: var(--color-bg-secondary); }
.video-card.selected { border-color: var(--color-accent-primary); }
.video-card-main { display: grid; gap: .15rem; min-width: 0; text-align: left; color: inherit; background: none; border: 0; cursor: pointer; }
.video-card-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-card-main small { color: var(--color-text-muted); }
.video-provider { font-size: .64rem; letter-spacing: .08em; color: var(--color-accent-primary); }
.video-card-actions { display: flex; flex-shrink: 0; gap: .4rem; }
.load-more { justify-self: center; }
.preview-card, .links-card { display: grid; gap: .75rem; }
.preview-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.preview-heading h2, .links-card h2 { margin: .3rem 0; font-size: 1.05rem; overflow-wrap: anywhere; }
.links-card h2 { margin-bottom: 0; }
.audio-link-row { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin: .4rem 0; padding: .55rem 0; border-top: 1px solid var(--color-border-subtle); }
.audio-link-row span, .audio-hits span:first-child { display: grid; min-width: 0; }
.offset-editor { display: flex; align-items: center; gap: .3rem; color: var(--color-text-muted); font-size: .75rem; }
.offset-editor input { width: 96px; }
.audio-link-row small, .audio-hits small { color: var(--color-text-muted); }
.audio-search-form { display: grid; gap: .6rem; border-top: 1px solid var(--color-border-subtle); padding-top: .7rem; }
.audio-search-form label { display: grid; gap: .35rem; }
.audio-hits { display: grid; max-height: 260px; overflow: auto; }
.audio-hit { display: flex; justify-content: space-between; align-items: center; gap: .5rem; text-align: left; color: inherit; background: transparent; border: 0; border-top: 1px solid var(--color-border-subtle); padding: .55rem 0; cursor: pointer; }
.audio-hit:disabled { opacity: .55; cursor: default; }
.audio-hit > span:last-child { color: var(--color-accent-primary); font-size: .8rem; white-space: nowrap; }
.empty-videos { padding: 1rem; text-align: center; }
.video-error { color: var(--color-danger, #d13438); margin: 0; }
@media (max-width: 860px) { .video-content-grid { grid-template-columns: minmax(0, 1fr); } .video-detail-column { order: -1; } }
@media (max-width: 600px) { .video-header { align-items: flex-start; } .external-form, .video-card { align-items: stretch; flex-direction: column; } .import-form { grid-template-columns: minmax(0, 1fr); } .import-title { grid-column: auto; } .video-card-actions { justify-content: flex-end; } }
</style>
