<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { parseXmlAttrs, useAuth } from "../api";
import BudgetedImage from "../components/BudgetedImage.vue";
import Icon from "../components/Icon.vue";
import { albumsFromXml, isSuccessfulSubsonicResponse, loadHomeSections, shuffled, tracksFromXml, type HomeAlbum, type HomeSection } from "../lib/homeMusic";
import { homeMessages } from "../locales/home";
import { useDetailStore } from "../stores/detail";
import { usePlayerStore } from "../stores/player";
import { WinButton } from "../vendor/winui";

const { locale } = useI18n();
const router = useRouter();
const { authFetch, coverArtUrl, hasPerm } = useAuth();
const player = usePlayerStore();
const detail = useDetailStore();
const blank: Record<HomeSection, HomeAlbum[]> = { newest: [], frequent: [], recent: [] };
const albums = ref<Record<HomeSection, HomeAlbum[]>>({ ...blank });
const loading = ref<Record<HomeSection, boolean>>({ newest: true, frequent: true, recent: true });
const failed = ref(new Set<HomeSection>());
const playingAlbum = ref("");
const playError = ref(false);
const brokenCovers = ref(new Set<string>());
let loadAbort: AbortController | null = null;
let loadVersion = 0;
let playAbort: AbortController | null = null;
let playVersion = 0;

function msg(key: keyof typeof homeMessages.en, params: Record<string, string | number> = {}) {
  return homeMessages[locale.value === "zh-CN" ? "zh-CN" : "en"][key].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}
const anyLoading = computed(() => Object.values(loading.value).some(Boolean));
const empty = computed(() => !anyLoading.value && failed.value.size === 0 && !albums.value.newest.length && !albums.value.frequent.length && !albums.value.recent.length);
const featured = computed(() => albums.value.newest[0] || albums.value.frequent[0] || albums.value.recent[0]);
const currentTrack = computed(() => player.current);
const canAdd = computed(() => hasPerm("manage_files"));
const canSources = computed(() => hasPerm("manage_sources"));

function validRows(xml: string) {
  if (!isSuccessfulSubsonicResponse(xml)) throw new Error("album list unavailable");
  return parseXmlAttrs(xml, "album");
}
async function loadAll() {
  loadAbort?.abort();
  const controller = new AbortController();
  loadAbort = controller;
  const version = ++loadVersion;
  loading.value = { newest: true, frequent: true, recent: true };
  const result = await loadHomeSections(async (section) => validRows(await authFetch("getAlbumList2", { type: section, size: "12" }, controller.signal)), albums.value);
  if (controller.signal.aborted || version !== loadVersion) return;
  albums.value = result.albums;
  failed.value = result.failed;
  loading.value = { newest: false, frequent: false, recent: false };
}
async function retry(section: HomeSection) {
  loading.value = { ...loading.value, [section]: true };
  try {
    const rows = validRows(await authFetch("getAlbumList2", { type: section, size: "12" }));
    albums.value = { ...albums.value, [section]: albumsFromXml(rows) };
    const next = new Set(failed.value); next.delete(section); failed.value = next;
  } catch { const next = new Set(failed.value); next.add(section); failed.value = next; }
  finally { loading.value = { ...loading.value, [section]: false }; }
}
async function play(album: HomeAlbum, shuffle = false) {
  playAbort?.abort();
  const controller = new AbortController();
  playAbort = controller;
  const version = ++playVersion;
  playingAlbum.value = album.id;
  playError.value = false;
  try {
    const xml = await authFetch("getAlbum", { id: album.id }, controller.signal);
    if (!isSuccessfulSubsonicResponse(xml)) throw new Error("album unavailable");
    const tracks = tracksFromXml(parseXmlAttrs(xml, "song"), album);
    if (!tracks.length) throw new Error("empty album");
    if (!controller.signal.aborted && version === playVersion) player.setQueue(shuffle ? shuffled(tracks) : tracks, 0);
  } catch {
    if (!controller.signal.aborted && version === playVersion) playError.value = true;
  }
  finally { if (version === playVersion) playingAlbum.value = ""; }
}
function hideCover(id: string) { brokenCovers.value = new Set([...brokenCovers.value, id]); }
function open(album: HomeAlbum) { detail.openAlbum(album.id); }
function go(path: string) { void router.push(path); }
function manage() { go(canAdd.value ? "/files" : "/sources"); }
onMounted(() => { void loadAll(); });
onBeforeUnmount(() => { loadVersion++; playVersion++; loadAbort?.abort(); playAbort?.abort(); });
</script>

<template>
  <main class="music-home" aria-labelledby="home-title">
    <header class="heading"><div><p class="eyebrow"><Icon name="headphones" /> EdgeSonic</p><h1 id="home-title">{{ msg('title') }}</h1><p>{{ msg('subtitle') }}</p></div><button class="quiet" type="button" :disabled="anyLoading" :aria-label="msg('refresh')" @click="loadAll"><Icon name="refresh" /><span>{{ msg('refresh') }}</span></button></header>
    <p v-if="playError" class="play-error" role="status">{{ msg('albumLoadFailed') }}</p>
    <section v-if="featured || currentTrack" class="listen-panel">
      <template v-if="currentTrack"><p class="eyebrow"><Icon name="headphones" />{{ msg('nowListening') }}</p><strong>{{ currentTrack.title }}</strong><span>{{ currentTrack.artist }} · {{ currentTrack.album }}</span><button class="text-action" type="button" @click="detail.openNowPlaying()">{{ msg('openNowPlaying') }}</button></template>
      <template v-else-if="featured"><p class="eyebrow"><Icon name="album" />{{ msg('featured') }}</p><strong>{{ featured.name }}</strong><span>{{ featured.artist }}</span><WinButton Style="AccentButtonStyle" CornerRadius="4" :IsEnabled="playingAlbum !== featured.id" @Click="play(featured)"><Icon name="play" />{{ msg('play') }}</WinButton></template>
    </section>
    <nav class="shortcuts" :aria-label="msg('shortcuts')"><button type="button" @click="go('/library')"><Icon name="library" />{{ msg('library') }}</button><button type="button" @click="go('/starred')"><Icon name="heart" />{{ msg('liked') }}</button><button type="button" @click="go('/playlists')"><Icon name="playlist" />{{ msg('playlists') }}</button></nav>
    <section v-if="empty" class="empty-library"><span class="empty-icon"><Icon name="album" size="32" /></span><h2>{{ msg('emptyTitle') }}</h2><p>{{ msg('emptyBody') }}</p><WinButton v-if="canAdd || canSources" Style="AccentButtonStyle" CornerRadius="4" @Click="manage"><Icon :name="canAdd ? 'upload' : 'tools'" />{{ canAdd ? msg('addMusic') : msg('manageSources') }}</WinButton></section>
    <div v-else class="sections">
      <section v-for="section in (['newest', 'frequent', 'recent'] as HomeSection[])" :key="section" class="album-section" :aria-busy="loading[section]">
        <header class="section-heading"><div><h2>{{ msg(section) }}</h2><p>{{ msg(`${section}Hint` as keyof typeof homeMessages.en) }}</p></div><Icon :name="section === 'newest' ? 'clock' : section === 'frequent' ? 'trending' : 'headphones'" /></header>
        <div v-if="loading[section]" class="grid loading-grid" :aria-label="msg('loadingAlbums')"><i v-for="index in 4" :key="index" /></div>
        <div v-else-if="failed.has(section)" class="section-error" role="status"><span>{{ msg('sectionLoadFailed') }}</span><button type="button" @click="retry(section)">{{ msg('retry') }}</button></div>
        <p v-else-if="!albums[section].length" class="section-empty">{{ section === 'recent' ? msg('noRecent') : section === 'frequent' ? msg('noFrequent') : msg('noAlbums') }}</p>
        <div v-else class="grid"><article v-for="album in albums[section]" :key="album.id" class="album-card"><button class="cover" type="button" :aria-label="msg('openAlbum', { name: album.name })" @click="open(album)"><BudgetedImage v-if="album.coverArt && !brokenCovers.has(album.id)" :src="coverArtUrl(album.coverArt, 320)" :alt="album.name" @error="hideCover(album.id)" /><Icon v-else name="album" size="34" /></button><div class="card-body"><button class="album-name" type="button" @click="open(album)">{{ album.name }}</button><p>{{ album.artist || '—' }}</p><small>{{ msg('albumMeta', { count: album.songCount, year: album.year || '—' }) }}</small><div class="actions"><button type="button" :disabled="playingAlbum === album.id" :aria-label="msg('playAlbum', { name: album.name })" @click="play(album)"><Icon name="play" /></button><button type="button" :disabled="playingAlbum === album.id" :aria-label="msg('shuffleAlbum', { name: album.name })" @click="play(album, true)"><Icon name="shuffle" /></button></div></div></article></div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.music-home{max-width:1440px;margin:auto;color:var(--color-text-primary)}.heading,.section-heading{display:flex;justify-content:space-between;gap:1rem}.heading{margin-bottom:1.4rem}.eyebrow{display:flex;align-items:center;gap:.45rem;margin:0 0 .55rem;color:var(--color-accent-primary);font-size:.8rem;font-weight:650}h1,h2,p{margin-top:0}h1{margin-bottom:.4rem;font-size:clamp(1.7rem,3vw,2.35rem);font-weight:600}.heading p:last-child,.section-heading p,.album-card p,.album-card small,.listen-panel span{color:var(--color-text-secondary)}.quiet,.shortcuts button,.section-error button,.actions button{border:1px solid color-mix(in srgb,var(--color-text-primary) 16%,transparent);border-radius:4px;background:var(--color-bg-secondary);color:var(--color-text-primary);font:inherit;cursor:pointer}.quiet{display:flex;align-items:center;gap:.4rem;padding:.5rem .7rem}button:focus-visible{outline:2px solid var(--color-accent-primary);outline-offset:3px}button:disabled{opacity:.55;cursor:wait}.play-error{padding:.65rem .8rem;margin:0 0 .8rem;border-left:3px solid #d83b01;border-radius:4px;background:color-mix(in srgb,#d83b01 10%,var(--color-bg-secondary))}.listen-panel{display:grid;grid-template-columns:1fr auto;gap:.35rem 1rem;padding:1rem 1.15rem;margin-bottom:.8rem;border:1px solid color-mix(in srgb,var(--color-accent-primary) 30%,transparent);border-radius:8px;background:color-mix(in srgb,var(--color-accent-primary) 8%,var(--color-bg-secondary))}.listen-panel .eyebrow{grid-column:1/-1;margin:0}.listen-panel .win-btn,.text-action{grid-column:2;grid-row:2/span 2}.text-action{border:0;background:transparent;color:var(--color-accent-primary);font:inherit;cursor:pointer}.shortcuts{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:2.25rem}.shortcuts button{display:flex;align-items:center;gap:.4rem;padding:.45rem .65rem}.sections{display:grid;gap:2.35rem}.section-heading{align-items:center;margin-bottom:.8rem}.section-heading h2{margin-bottom:.2rem;font-size:1.13rem}.section-heading p{margin-bottom:0;font-size:.87rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:1rem}.album-card{min-width:0;padding:.5rem;border-radius:8px}.album-card:hover{background:color-mix(in srgb,var(--color-text-primary) 6%,transparent)}.cover{display:grid;width:100%;aspect-ratio:1;place-items:center;overflow:hidden;padding:0;border:0;border-radius:6px;background:linear-gradient(145deg,color-mix(in srgb,var(--color-accent-primary) 25%,var(--color-bg-secondary)),var(--color-bg-secondary));color:var(--color-text-secondary);cursor:pointer}.cover :deep(img){width:100%;height:100%;object-fit:cover}.card-body{padding:.65rem .1rem 0}.album-name{display:block;width:100%;overflow:hidden;padding:0;border:0;background:transparent;color:var(--color-text-primary);font:600 .92rem/1.35 var(--font-body);text-align:left;white-space:nowrap;text-overflow:ellipsis;cursor:pointer}.album-card p,.album-card small{display:block;overflow:hidden;margin:.2rem 0 0;font-size:.8rem;white-space:nowrap;text-overflow:ellipsis}.album-card small{font-size:.73rem}.actions{display:flex;gap:.35rem;margin-top:.55rem}.actions button{display:grid;place-items:center;width:2rem;height:2rem;padding:0;color:#fff;background:#303030;border-color:#606060;border-radius:50%}.actions button:hover:not(:disabled){background:var(--color-accent-primary);border-color:var(--color-accent-primary)}.section-empty{color:var(--color-text-secondary)}.section-error{display:flex;gap:.75rem;align-items:center;padding:.7rem .85rem;border-left:3px solid #d83b01;border-radius:4px;background:color-mix(in srgb,#d83b01 10%,var(--color-bg-secondary))}.section-error button{padding:.3rem .55rem}.loading-grid i{aspect-ratio:.74;border-radius:8px;background:color-mix(in srgb,var(--color-text-primary) 7%,transparent)}.empty-library{max-width:510px;padding:3.4rem 1.5rem;margin:9vh auto 0;text-align:center;border:1px solid color-mix(in srgb,var(--color-text-primary) 10%,transparent);border-radius:8px;background:color-mix(in srgb,var(--color-bg-secondary) 88%,transparent)}.empty-icon{display:inline-grid;place-items:center;width:4rem;height:4rem;margin-bottom:1rem;border-radius:50%;background:color-mix(in srgb,var(--color-accent-primary) 14%,transparent);color:var(--color-accent-primary)}@media(max-width:680px){.quiet span{display:none}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem}.album-card{padding:.35rem}.listen-panel{grid-template-columns:1fr}.listen-panel .win-btn,.text-action{grid-column:auto;grid-row:auto;justify-self:start}}
</style>
