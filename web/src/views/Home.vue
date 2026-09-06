<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { parseXmlAttrs, useAuth } from "../api";
import Icon from "../components/Icon.vue";
import { albumsFromXml, shuffled, tracksFromXml, type HomeAlbum } from "../lib/homeMusic";
import { homeMessages } from "../locales/home";
import { usePlayerStore } from "../stores/player";
import { useDetailStore } from "../stores/detail";

const { locale } = useI18n();
const router = useRouter();
const { authFetch, coverArtUrl, hasPerm } = useAuth();
const player = usePlayerStore();
const detail = useDetailStore();

type Section = "newest" | "frequent" | "recent";
const albums = ref<Record<Section, HomeAlbum[]>>({ newest: [], frequent: [], recent: [] });
const loading = ref(true);
const error = ref("");
const playingAlbum = ref("");
let controller: AbortController | null = null;
let requestId = 0;

function msg(key: keyof typeof homeMessages.en, params: Record<string, string | number> = {}) {
  const messages = homeMessages[locale.value === "zh-CN" ? "zh-CN" : "en"];
  return messages[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}

const isEmpty = computed(() => !loading.value && !albums.value.newest.length && !albums.value.frequent.length && !albums.value.recent.length);
const canAddMusic = computed(() => hasPerm("manage_files"));
const canManageSources = computed(() => hasPerm("manage_sources"));

function sectionType(section: Section) {
  return section === "newest" ? "newest" : section;
}

async function loadHome() {
  controller?.abort();
  controller = new AbortController();
  const currentRequest = ++requestId;
  loading.value = true;
  error.value = "";
  try {
    const sections: Section[] = ["newest", "frequent", "recent"];
    const results = await Promise.all(sections.map(async (section) => {
      const xml = await authFetch("getAlbumList2", { type: sectionType(section), size: "12" }, controller?.signal);
      return [section, albumsFromXml(parseXmlAttrs(xml, "album"))] as const;
    }));
    if (currentRequest !== requestId) return;
    albums.value = Object.fromEntries(results) as Record<Section, HomeAlbum[]>;
  } catch (cause) {
    if (controller?.signal.aborted || currentRequest !== requestId) return;
    albums.value = { newest: [], frequent: [], recent: [] };
    error.value = msg("loadFailed");
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

async function playAlbum(album: HomeAlbum, shuffle = false) {
  playingAlbum.value = album.id;
  try {
    const xml = await authFetch("getAlbum", { id: album.id });
    const tracks = tracksFromXml(parseXmlAttrs(xml, "song"), album);
    if (!tracks.length) throw new Error("empty album");
    player.setQueue(shuffle ? shuffled(tracks) : tracks, 0);
  } catch {
    error.value = msg("albumLoadFailed");
  } finally {
    playingAlbum.value = "";
  }
}

function openAlbum(album: HomeAlbum) {
  detail.openAlbum(album.id);
}

function onAlbumKeydown(event: KeyboardEvent, album: HomeAlbum) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openAlbum(album);
  }
}

function manageLibrary() {
  void router.push(canAddMusic.value ? "/files" : "/sources");
}

onMounted(loadHome);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <main class="music-home" aria-labelledby="home-title">
    <header class="home-heading">
      <div>
        <p class="eyebrow"><Icon name="headphones" size="16" /> EdgeSonic</p>
        <h1 id="home-title">{{ msg("title") }}</h1>
        <p>{{ msg("subtitle") }}</p>
      </div>
      <button class="quiet-button" type="button" :disabled="loading" @click="loadHome">
        <Icon name="refresh" /> {{ msg("retry") }}
      </button>
    </header>

    <section v-if="error" class="home-error" role="alert">
      <Icon name="warn" />
      <span>{{ error }}</span>
      <button type="button" @click="loadHome">{{ msg("retry") }}</button>
    </section>

    <section v-if="isEmpty" class="empty-library">
      <span class="empty-icon"><Icon name="album" size="32" /></span>
      <h2>{{ msg("emptyTitle") }}</h2>
      <p>{{ msg("emptyBody") }}</p>
      <button v-if="canAddMusic || canManageSources" class="accent-button" type="button" @click="manageLibrary">
        <Icon :name="canAddMusic ? 'upload' : 'tools'" />
        {{ canAddMusic ? msg("addMusic") : msg("manageSources") }}
      </button>
    </section>

    <div v-else class="home-sections" :aria-busy="loading">
      <section v-for="section in (['newest', 'frequent', 'recent'] as Section[])" :key="section" class="album-section" :aria-labelledby="`${section}-heading`">
        <div class="section-heading">
          <div>
            <h2 :id="`${section}-heading`">{{ msg(section) }}</h2>
            <p>{{ msg(`${section}Hint` as keyof typeof homeMessages.en) }}</p>
          </div>
          <Icon :name="section === 'newest' ? 'clock' : section === 'frequent' ? 'trending' : 'headphones'" size="20" />
        </div>

        <div v-if="loading" class="album-grid loading-grid" aria-label="Loading albums">
          <div v-for="item in 4" :key="item" class="album-skeleton" />
        </div>
        <p v-else-if="!albums[section].length" class="section-empty">
          {{ section === "recent" ? msg("noRecent") : section === "frequent" ? msg("noFrequent") : msg("noAlbums") }}
        </p>
        <div v-else class="album-grid">
          <article
            v-for="album in albums[section]"
            :key="album.id"
            class="album-card"
            role="button"
            tabindex="0"
            :aria-label="msg('openAlbum', { name: album.name })"
            @click="openAlbum(album)"
            @keydown="onAlbumKeydown($event, album)"
          >
            <div class="cover-frame">
              <img v-if="album.coverArt" :src="coverArtUrl(album.coverArt, 320)" :alt="album.name" loading="lazy" />
              <Icon v-else name="album" size="34" />
              <div class="album-actions">
                <button type="button" :disabled="playingAlbum === album.id" :aria-label="msg('playAlbum', { name: album.name })" @click.stop="playAlbum(album)">
                  <Icon name="play" />
                </button>
                <button type="button" :disabled="playingAlbum === album.id" :aria-label="msg('shuffleAlbum', { name: album.name })" @click.stop="playAlbum(album, true)">
                  <Icon name="shuffle" />
                </button>
              </div>
            </div>
            <h3>{{ album.name }}</h3>
            <p>{{ album.artist || "—" }}</p>
            <small>{{ msg("albumMeta", { count: album.songCount, year: album.year || "—" }) }}</small>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.music-home { max-width: 1440px; margin: 0 auto; color: var(--color-text-primary); }
.home-heading, .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.home-heading { margin-bottom: 2.25rem; }
.eyebrow { display: flex; align-items: center; gap: .45rem; margin: 0 0 .55rem; color: var(--color-accent-primary); font-size: .8rem; font-weight: 650; letter-spacing: .04em; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: .42rem; font-size: clamp(1.7rem, 3vw, 2.35rem); font-weight: 600; letter-spacing: -.025em; }
.home-heading > div > p:last-child, .section-heading p { color: var(--color-text-secondary); }
.home-heading > div > p:last-child { margin-bottom: 0; }
.quiet-button, .home-error button, .accent-button, .album-actions button { border: 1px solid color-mix(in srgb, var(--color-text-primary) 16%, transparent); border-radius: 4px; font: inherit; cursor: pointer; }
.quiet-button { display: inline-flex; align-items: center; gap: .45rem; padding: .5rem .72rem; background: color-mix(in srgb, var(--color-bg-secondary) 82%, transparent); color: var(--color-text-primary); }
.quiet-button:hover:not(:disabled), .home-error button:hover { background: color-mix(in srgb, var(--color-accent-primary) 12%, var(--color-bg-secondary)); }
button:focus-visible, [role="button"]:focus-visible { outline: 2px solid var(--color-accent-primary); outline-offset: 3px; }
button:disabled { cursor: wait; opacity: .55; }
.home-error { display: flex; align-items: center; gap: .65rem; padding: .75rem 1rem; margin-bottom: 1.5rem; border-left: 3px solid #d83b01; border-radius: 4px; background: color-mix(in srgb, #d83b01 10%, var(--color-bg-secondary)); }
.home-error button { margin-left: auto; padding: .3rem .55rem; background: transparent; color: inherit; }
.home-sections { display: grid; gap: 2.35rem; }
.section-heading { align-items: center; margin-bottom: .8rem; }
.section-heading h2 { margin-bottom: .2rem; font-size: 1.13rem; font-weight: 600; }
.section-heading p { margin-bottom: 0; font-size: .87rem; }
.section-heading > .es-icon { color: var(--color-accent-primary); }
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 1rem; }
.album-card { min-width: 0; padding: .5rem; border-radius: 8px; cursor: pointer; transition: background .14s ease, transform .14s ease; }
.album-card:hover { background: color-mix(in srgb, var(--color-text-primary) 6%, transparent); transform: translateY(-1px); }
.cover-frame { position: relative; display: grid; aspect-ratio: 1; place-items: center; overflow: hidden; border-radius: 6px; background: linear-gradient(145deg, color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-secondary)), var(--color-bg-secondary)); color: var(--color-text-secondary); box-shadow: 0 1px 2px color-mix(in srgb, #000 22%, transparent); }
.cover-frame img { width: 100%; height: 100%; object-fit: cover; }
.album-actions { position: absolute; right: .45rem; bottom: .45rem; display: flex; gap: .35rem; opacity: 0; transform: translateY(3px); transition: opacity .14s, transform .14s; }
.album-card:hover .album-actions, .album-card:focus-within .album-actions { opacity: 1; transform: none; }
.album-actions button { display: grid; place-items: center; width: 2rem; height: 2rem; padding: 0; color: var(--color-text-inverse); background: color-mix(in srgb, #202020 82%, transparent); border-color: transparent; border-radius: 50%; }
.album-actions button:hover:not(:disabled) { background: var(--color-accent-primary); }
.album-card h3 { overflow: hidden; margin: .65rem 0 .2rem; font-size: .92rem; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.album-card p, .album-card small { display: block; overflow: hidden; margin: 0; color: var(--color-text-secondary); font-size: .8rem; white-space: nowrap; text-overflow: ellipsis; }
.album-card small { margin-top: .22rem; opacity: .78; font-size: .73rem; }
.section-empty { padding: 1rem 0; margin: 0; color: var(--color-text-secondary); font-size: .9rem; }
.loading-grid { pointer-events: none; }
.album-skeleton { aspect-ratio: .74; border-radius: 8px; background: linear-gradient(100deg, color-mix(in srgb, var(--color-text-primary) 5%, transparent) 30%, color-mix(in srgb, var(--color-text-primary) 10%, transparent) 50%, color-mix(in srgb, var(--color-text-primary) 5%, transparent) 70%); background-size: 200% 100%; animation: shine 1.4s linear infinite; }
@keyframes shine { to { background-position: -200% 0; } }
.empty-library { max-width: 510px; padding: 3.4rem 1.5rem; margin: 9vh auto 0; text-align: center; border: 1px solid color-mix(in srgb, var(--color-text-primary) 10%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--color-bg-secondary) 88%, transparent); }
.empty-icon { display: inline-grid; place-items: center; width: 4rem; height: 4rem; margin-bottom: 1rem; border-radius: 50%; background: color-mix(in srgb, var(--color-accent-primary) 14%, transparent); color: var(--color-accent-primary); }
.empty-library h2 { margin-bottom: .4rem; font-size: 1.2rem; }
.empty-library p { margin-bottom: 1.35rem; color: var(--color-text-secondary); }
.accent-button { display: inline-flex; align-items: center; gap: .45rem; padding: .58rem .85rem; color: var(--color-text-inverse); background: var(--color-accent-primary); border-color: var(--color-accent-primary); }
@media (max-width: 680px) { .home-heading { margin-bottom: 1.6rem; } .home-heading, .section-heading { align-items: flex-start; } .quiet-button { flex-shrink: 0; font-size: 0; } .quiet-button .es-icon { font-size: 1rem; } .album-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; } .album-card { padding: .35rem; } .album-actions { opacity: 1; transform: none; } .home-error { align-items: flex-start; } }
</style>
