
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, parseXmlInner, formatDuration } from "../api";
import { usePlayerStore, type Track } from "../stores/player";
import { useDetailStore } from "../stores/detail";
import TagEditor from "../components/TagEditor.vue";
import Icon from "../components/Icon.vue";
import ScrapeButton from "../components/ScrapeButton.vue";
import SongRowMenu from "../components/SongRowMenu.vue";
import ListOptionsMenu from "../components/ListOptionsMenu.vue";
import StarButton from "../components/StarButton.vue";
import ShareDialog from "../components/ShareDialog.vue";
import BudgetedImage from "../components/BudgetedImage.vue";
import { showInfo } from "../stores/toast";
import { isInstrumentalTitle } from "../lib/instrumental";
import type { ScrapeResult } from "../lib/scrape";
import { buildLibrarySearchParams, buildLibrarySearchRoute, LIBRARY_PAGE_SIZES, paginateLibraryItems, type LibraryPageSize } from "../lib/librarySearch";
import { foldAlbumDisplayCards, type AlbumDisplayGroupSummary, type AlbumDisplayCard } from "../lib/albumDisplayGroups";
import { FluentSelect } from "@platform-kit/fluent/vue";

const { t } = useI18n();

const { authFetch, edgesonicFetch, writeTags, batchWriteTags, rescanSongs, coverArtUrl, downloadUrl, isAdmin, hasPerm } = useAuth();
const player = usePlayerStore();
const detail = useDetailStore();
const BATCH_MAX = 50;

const props = withDefaults(defineProps<{
  starredOnly?: boolean;
  embedded?: boolean;
  detailTarget?: { kind: "album" | "artist"; id: string };
}>(), { starredOnly: false, embedded: false, detailTarget: undefined });
const starredOnly = props.starredOnly;
const canManageFiles = computed(() => hasPerm("manage_files"));
const canShare = computed(() => hasPerm("share"));

interface Artist { id: string; name: string; albumCount: string; starred: boolean; starredAt?: string; createdAt?: string; }
interface Album {
  id: string;
  name: string;
  artist: string;
  year: string;
  coverArt: string;
  songCount: string;
  starred: boolean;
  starredAt?: string;
  createdAt?: string;
}
interface AlbumDisplayGroupDetail extends AlbumDisplayGroupSummary {
  editions: Album[];
}

type Tab = "artists" | "albums" | "songs";
type SortMode = "newest" | "oldestStarred" | "newestAdded" | "oldestAdded" | "nameAsc" | "nameDesc";
// ?tab= lets other pages (dashboard stat cards) land on a specific view.
const route = useRoute();
const router = useRouter();
const requestedTab = props.embedded ? "" : String(route.query.tab || "");
const tab = ref<Tab>(
  requestedTab === "artists" || requestedTab === "albums" || requestedTab === "songs"
    ? requestedTab
    : "songs",
);
const sortMode = ref<SortMode>("newest");
const pageSize = ref<LibraryPageSize>(50);
const listPage = ref(1);
const searchPages = ref({ artists: 1, albums: 1, songs: 1 });
const searchHasMore = ref({ artists: false, albums: false, songs: false });
const searchAlbumRows = ref<Album[]>([]);
const searchAlbumOffset = ref(0);
const searchAlbumsDone = ref(false);
const searchSongRows = ref<Track[]>([]);
const searchSongOffset = ref(0);
const searchSongsDone = ref(false);
let searchDataRequest = 0;

const artists = ref<Artist[]>([]);
const albums = ref<Album[]>([]);
const songs = ref<Track[]>([]);

interface StarredLists {
  artists: Artist[];
  albums: Album[];
  songs: Track[];
}
const starredLists = ref<StarredLists>({ artists: [], albums: [], songs: [] });
const starredLoading = ref(false);
const starredLoaded = ref(false);
let starredRequest = 0;

function timeValue(value?: string): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

type DatedItem = { starredAt?: string; createdAt?: string };
type DateSort = { field: "starredAt" | "createdAt"; descending: boolean };

function activeDateSort(): DateSort | null {
  if (starredOnly && sortMode.value === "newest") {
    return { field: "starredAt", descending: true };
  }
  if (starredOnly && sortMode.value === "oldestStarred") {
    return { field: "starredAt", descending: false };
  }
  if (sortMode.value === "newestAdded" || (!starredOnly && sortMode.value === "newest")) {
    return { field: "createdAt", descending: true };
  }
  if (sortMode.value === "oldestAdded") {
    return { field: "createdAt", descending: false };
  }
  return null;
}

function compareDates(a: DatedItem, b: DatedItem, sort: DateSort): number {
  const av = timeValue(a[sort.field]);
  const bv = timeValue(b[sort.field]);
  if (av === 0 && bv !== 0) return 1;
  if (bv === 0 && av !== 0) return -1;
  return sort.descending ? bv - av : av - bv;
}

function nameOrder(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function sortArtists(items: Artist[]): Artist[] {
  return [...items].sort((a, b) => {
    const dateSort = activeDateSort();
    if (dateSort) {
      const byDate = compareDates(a, b, dateSort);
      if (byDate) return byDate;
    }
    const byName = nameOrder(a.name, b.name);
    return sortMode.value === "nameDesc" ? -byName : byName;
  });
}

function sortAlbums(items: Album[]): Album[] {
  return [...items].sort((a, b) => {
    const dateSort = activeDateSort();
    if (dateSort) {
      const byDate = compareDates(a, b, dateSort);
      if (byDate) return byDate;
    }
    const byName = nameOrder(a.name, b.name);
    return sortMode.value === "nameDesc" ? -byName : byName;
  });
}

function sortSongs(items: Track[]): Track[] {
  return [...items].sort((a, b) => {
    const dateSort = activeDateSort();
    if (dateSort) {
      const byDate = compareDates(a, b, dateSort);
      if (byDate) return byDate;
    }
    const byName = nameOrder(a.title, b.title);
    return sortMode.value === "nameDesc" ? -byName : byName;
  });
}

interface ArtistInfo {
  biography: string;
  imageUrl: string;
  lastFmUrl: string;
  mbid: string;
}
const artistInfo = ref<ArtistInfo | null>(null);
const artistInfoLoading = ref(false);
const artistInfoError = ref("");
let artistInfoRequest = 0;

const currentArtist = ref<Artist | null>(null);
const currentAlbum = ref<Album | null>(null);
const currentDisplayGroup = ref<AlbumDisplayGroupDetail | null>(null);
const displayGroups = ref<AlbumDisplayGroupSummary[]>([]);
let displayGroupsLoaded = false;
let displayGroupsPromise: Promise<void> | null = null;
const groupDetailLoading = ref(false);
let groupDetailRequest = 0;
const loading = ref(false);
const error = ref("");
let detailRequest = 0;
let detailController: AbortController | null = null;

const allAlbums = ref<Album[]>([]);
const albumOffset = ref(0);
const albumsDone = ref(false);
let albumLoadRequest = 0;
let albumLoadPromise: Promise<void> | null = null;

const WATERFALL_COL_TARGET = 190; // matches the old minmax() card width
const WATERFALL_GAP = 16; // px, mirrors the 1rem gap in CSS below
const albumWaterfallEl = ref<HTMLElement | null>(null);
function waterfallColumnsFor(width: number): number {
  const count = Math.max(1, Math.floor((width + WATERFALL_GAP) / (WATERFALL_COL_TARGET + WATERFALL_GAP)));
  return typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches
    ? Math.min(3, Math.max(2, count))
    : count;
}
const waterfallColCount = ref(
  typeof window !== "undefined"
    ? waterfallColumnsFor(window.innerWidth)
    : 4,
);
let waterfallRO: ResizeObserver | null = null;
watch(albumWaterfallEl, (el) => {
  if (waterfallRO) { waterfallRO.disconnect(); waterfallRO = null; }
  if (!el || typeof ResizeObserver === "undefined") return;
  waterfallColCount.value = waterfallColumnsFor(el.clientWidth);
  waterfallRO = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w) waterfallColCount.value = waterfallColumnsFor(w);
  });
  waterfallRO.observe(el);
});
const albumDisplayCards = computed<AlbumDisplayCard<Album>[]>(() =>
  foldAlbumDisplayCards(allAlbums.value, displayGroups.value)
);
const pagedAlbumDisplayCards = computed(() => albumDisplayCards.value.slice((listPage.value - 1) * pageSize.value, listPage.value * pageSize.value));
const albumWaterfallCols = computed<AlbumDisplayCard<Album>[][]>(() => {
  const n = waterfallColCount.value;
  const cols: AlbumDisplayCard<Album>[][] = Array.from({ length: n }, () => []);
  pagedAlbumDisplayCards.value.forEach((item, i) => cols[i % n].push(item));
  return cols;
});

const allSongs = ref<Track[]>([]);
const songOffset = ref(0);
const songsDone = ref(false);
let songLoadRequest = 0;
let songLoadPromise: Promise<void> | null = null;
let locateRetryId: string | null = null;
const locatingCurrent = ref(false);

// Backing tracks are only distinguishable by their title suffix, so the filter
// runs client-side over whatever pages have been fetched.
const HIDE_INSTRUMENTAL_KEY = "edgesonic_hide_instrumental";
const hideInstrumental = ref(localStorage.getItem(HIDE_INSTRUMENTAL_KEY) === "1");
watch(hideInstrumental, (on) => {
  localStorage.setItem(HIDE_INSTRUMENTAL_KEY, on ? "1" : "0");
  listPage.value = 1;
  if (isSearchActive.value) {
    searchPages.value = { ...searchPages.value, songs: 1 };
    searchSongRows.value = [];
    searchSongOffset.value = 0;
    searchSongsDone.value = false;
    searchDataRequest++;
    void runSearch(searchQuery.value.trim(), lyricsQuery.value.trim());
  } else if (!starredOnly && tab.value === "songs") {
    void ensureSongItems(pageSize.value + 1);
  }
});

function dropInstrumentals(items: Track[]): Track[] {
  return hideInstrumental.value ? items.filter((s) => !isInstrumentalTitle(s.title)) : items;
}

const artistRows = computed(() => sortArtists(starredOnly ? starredLists.value.artists : artists.value));
const albumRows = computed(() => starredOnly ? sortAlbums(starredLists.value.albums) : allAlbums.value);
const songRows = computed(() => dropInstrumentals(starredOnly ? sortSongs(starredLists.value.songs) : allSongs.value));
const displayArtists = computed(() => paginateLibraryItems(artistRows.value, listPage.value, pageSize.value).items);
const displayAlbums = computed(() => paginateLibraryItems(albumRows.value, listPage.value, pageSize.value).items);
const displaySongs = computed(() => songRows.value.slice((listPage.value - 1) * pageSize.value, listPage.value * pageSize.value));
const albumSongs = computed(() => dropInstrumentals(songs.value));
const listHasNext = computed(() => tab.value === "artists"
  ? artistRows.value.length > listPage.value * pageSize.value
  : tab.value === "albums"
    ? (starredOnly ? albumRows.value.length : albumDisplayCards.value.length) > listPage.value * pageSize.value
    : songRows.value.length > listPage.value * pageSize.value);
const pageSizeOptions = LIBRARY_PAGE_SIZES.map((value) => ({ value: String(value), label: String(value) }));

function switchTab(next: Tab) {
  detailRequest++;
  groupDetailRequest++;
  tab.value = next;
  listPage.value = 1;
  currentArtist.value = null;
  currentAlbum.value = null;
  currentDisplayGroup.value = null;
  groupDetailLoading.value = false;
  albums.value = [];
  songs.value = [];
  error.value = "";
  artistInfo.value = null;
  artistInfoError.value = "";
  artistInfoRequest++;
  if (starredOnly) {
    void loadStarred();
  } else {
    if (next === "artists" && !artists.value.length) loadArtists();
    if (next === "albums") void ensureAlbumItems(pageSize.value + 1);
    if (next === "songs") void ensureSongItems(pageSize.value + 1);
  }
}

async function setListPage(page: number) {
  const requested = Math.max(1, Math.floor(page));
  listPage.value = requested;
  if (!starredOnly && tab.value === "albums") await ensureAlbumItems(requested * pageSize.value + 1);
  if (!starredOnly && tab.value === "songs") await ensureSongItems(requested * pageSize.value + 1);
  const available = tab.value === "artists" ? artistRows.value.length
    : tab.value === "albums" ? (starredOnly ? albumRows.value.length : albumDisplayCards.value.length)
    : songRows.value.length;
  if (starredOnly || tab.value === "artists" || (tab.value === "albums" && albumsDone.value) || (tab.value === "songs" && songsDone.value)) {
    listPage.value = Math.min(requested, Math.max(1, Math.ceil(available / pageSize.value)));
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadArtists() {
  loading.value = true;
  error.value = "";
  try {
    const xml = await authFetch("getArtists");
    artists.value = parseXmlAttrs(xml, "artist").map((a) => ({
      id: a.id || "", name: a.name || "", albumCount: a.albumCount || "",
      starred: !!a.starred, starredAt: a.starred || undefined, createdAt: a.created || undefined,
    }));
  } catch {
    error.value = t("library.loadFailed");
    artists.value = [];
  }
  loading.value = false;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

function artistInfoField(xml: string, tag: string): string {
  return decodeXmlEntities(parseXmlInner(xml, tag).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

async function loadStarred(force = false) {
  if (starredLoading.value || (!force && starredLoaded.value)) return;
  const request = ++starredRequest;
  starredLoading.value = true;
  error.value = "";
  try {
    const xml = await authFetch("getStarred2");
    if (/status="failed"/.test(xml)) throw new Error("getStarred2 failed");
    if (request !== starredRequest) return;
    starredLists.value = {
      artists: parseXmlAttrs(xml, "artist").map((a) => ({
        id: a.id || "", name: a.name || "", albumCount: a.albumCount || "",
        starred: true, starredAt: a.starred || undefined, createdAt: a.created || undefined,
      })),
      albums: parseXmlAttrs(xml, "album").map((a) => ({
        id: a.id || "", name: a.name || "", artist: a.artist || "", year: a.year || "",
        coverArt: a.coverArt || "", songCount: a.songCount || "", starred: true,
        starredAt: a.starred || undefined, createdAt: a.created || undefined,
      })),
      songs: parseXmlAttrs(xml, "song").map(mapSongRow),
    };
    starredLoaded.value = true;
  } catch {
    if (request === starredRequest) error.value = t("library.starredLoadFailed");
  } finally {
    if (request === starredRequest) starredLoading.value = false;
  }
}

function loadMoreAlbums(count: number = pageSize.value): Promise<void> {
  if (albumLoadPromise) return albumLoadPromise;
  const request = albumLoadRequest;
  const promise = (async () => {
    loading.value = true;
    try {
      const [xml] = await Promise.all([authFetch("getAlbumList2", {
        type: sortMode.value === "newest" || sortMode.value === "newestAdded"
          ? "newest"
          : sortMode.value === "oldestAdded" ? "oldest"
          : sortMode.value === "nameDesc" ? "alphabeticalByNameDesc" : "alphabeticalByName",
        size: String(Math.min(500, Math.max(1, count))), offset: String(albumOffset.value),
      }), ensureAlbumDisplayGroups()]);
      const page = parseXmlAttrs(xml, "album").map((a) => ({
        id: a.id || "", name: a.name || "", artist: a.artist || "",
        year: a.year || "", coverArt: a.coverArt || "", songCount: a.songCount || "",
        starred: !!a.starred, starredAt: a.starred || undefined, createdAt: a.created || undefined,
      }));
      if (request !== albumLoadRequest) return;
      allAlbums.value.push(...page);
      albumOffset.value += page.length;
      if (page.length < count) albumsDone.value = true;
    } catch {
      if (request === albumLoadRequest) error.value = t("library.loadFailed");
    } finally {
      if (request === albumLoadRequest) loading.value = false;
    }
  })();
  const wrapped = promise.finally(() => { if (albumLoadPromise === wrapped) albumLoadPromise = null; });
  albumLoadPromise = wrapped;
  return wrapped;
}

async function ensureAlbumItems(target: number) {
  while (!albumsDone.value && albumDisplayCards.value.length < target) {
    const missing = Math.max(1, target - albumDisplayCards.value.length);
    const before = albumOffset.value;
    await loadMoreAlbums(Math.min(200, Math.max(pageSize.value, missing)));
    if (albumOffset.value === before && albumsDone.value) break;
    if (albumOffset.value === before && error.value) break;
  }
}

async function ensureAlbumDisplayGroups(): Promise<void> {
  if (displayGroupsLoaded) return;
  if (displayGroupsPromise) return displayGroupsPromise;
  displayGroupsPromise = (async () => {
    try {
      const response = JSON.parse(await edgesonicFetch("album-display-groups")) as {
        ok?: boolean;
        groups?: AlbumDisplayGroupSummary[];
      };
      if (response.ok && Array.isArray(response.groups)) displayGroups.value = response.groups;
    } catch {
      displayGroups.value = [];
    } finally {
      displayGroupsLoaded = true;
      displayGroupsPromise = null;
    }
  })();
  return displayGroupsPromise;
}

async function openDisplayGroup(group: AlbumDisplayGroupSummary) {
  const request = ++groupDetailRequest;
  currentAlbum.value = null;
  currentArtist.value = null;
  currentDisplayGroup.value = { ...group, editions: [] };
  songs.value = [];
  albums.value = [];
  error.value = "";
  groupDetailLoading.value = true;
  try {
    const response = JSON.parse(await edgesonicFetch(`album-display-groups/${encodeURIComponent(group.id)}`)) as {
      ok?: boolean;
      group?: { id: string; name: string; editions: Album[] };
    };
    if (request !== groupDetailRequest) return;
    if (!response.ok || !response.group || response.group.editions.length < 2) throw new Error("Display group unavailable");
    currentDisplayGroup.value = {
      ...group,
      name: response.group.name,
      editions: response.group.editions,
    };
  } catch {
    if (request === groupDetailRequest) error.value = t("library.loadFailed");
  } finally {
    if (request === groupDetailRequest) {
      groupDetailLoading.value = false;
    }
  }
}

function mapSongRow(s: Record<string, string>): Track {
  return {
    id: s.id || "",
    title: s.title || "",
    artist: s.artist || "",
    album: s.album || "",
    coverArt: s.coverArt || undefined,
    duration: parseInt(s.duration || "0"),
    starred: !!s.starred,
    starredAt: s.starred || undefined,
    createdAt: s.created || undefined,
    artistId: s.artistId || undefined,
    albumId: s.albumId || undefined,
  };
}

function loadMoreSongs(count: number = pageSize.value): Promise<void> {
  if (songLoadPromise) return songLoadPromise;
  const request = songLoadRequest;
  const promise = (async () => {
    loading.value = true;
    try {
      const xml = await authFetch("search3", {
        query: "", artistCount: "0", albumCount: "0",
        songCount: String(Math.min(500, Math.max(1, count))), songOffset: String(songOffset.value),
        songSort: sortMode.value === "newest" || sortMode.value === "newestAdded"
          ? "newest"
          : sortMode.value === "oldestAdded" ? "oldest"
          : sortMode.value === "nameDesc" ? "titleDesc" : "title",
      });
      const page = parseXmlAttrs(xml, "song").map(mapSongRow);
      if (request !== songLoadRequest) return;
      allSongs.value.push(...page);
      songOffset.value += page.length;
      if (page.length < count) songsDone.value = true;
    } catch {
      if (request === songLoadRequest) error.value = t("library.loadFailed");
    } finally {
      if (request === songLoadRequest) loading.value = false;
    }
  })();
  const wrapped = promise.finally(() => { if (songLoadPromise === wrapped) songLoadPromise = null; });
  songLoadPromise = wrapped;
  return wrapped;
}

async function ensureSongItems(target: number) {
  while (!songsDone.value && songRows.value.length < target) {
    const missing = Math.max(1, target - songRows.value.length);
    const before = songOffset.value;
    await loadMoreSongs(Math.min(200, Math.max(pageSize.value, missing)));
    if (songOffset.value === before && songsDone.value) break;
    if (songOffset.value === before && error.value) break;
  }
}

async function scrollToCurrentSong(id: string): Promise<boolean> {
  await nextTick();
  const row = Array.from(document.querySelectorAll<HTMLElement>(".song-row[data-song-id]")).find((el) => el.dataset.songId === id);
  if (!row) return false;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("song-row-located");
  setTimeout(() => row.classList.remove("song-row-located"), 1600);
  return true;
}

async function locateCurrentSong() {
  const id = player.current?.id;
  if (!id) {
    showInfo(t("library.locateNoCurrent"));
    return;
  }
  if (tab.value !== "songs") switchTab("songs");
  await nextTick();
  const loadedIndex = songRows.value.findIndex((song) => song.id === id);
  if (loadedIndex >= 0) {
    listPage.value = Math.floor(loadedIndex / pageSize.value) + 1;
    await nextTick();
  }
  if (await scrollToCurrentSong(id)) {
    locateRetryId = null;
    return;
  }
  if (locateRetryId !== id) {
    locateRetryId = id;
    showInfo(t("library.locateLoadMore"));
    return;
  }

  locatingCurrent.value = true;
  try {
    if (starredOnly) {
      await loadStarred(true);
    } else {
      while (!songsDone.value && !allSongs.value.some((song) => song.id === id)) {
        await loadMoreSongs(pageSize.value);
      }
    }
    const index = songRows.value.findIndex((song) => song.id === id);
    if (index >= 0) {
      listPage.value = Math.floor(index / pageSize.value) + 1;
      await nextTick();
    }
    if (await scrollToCurrentSong(id)) locateRetryId = null;
    else showInfo(t(starredOnly ? "library.locateNotLiked" : "library.locateNotFound"));
  } finally {
    locatingCurrent.value = false;
  }
}

watch(sortMode, () => {
  if (props.embedded) return;
  listPage.value = 1;
  resetSearchPages();
  if (starredOnly) return;
  if (isSearchActive.value) {
    if (searchTimer) clearTimeout(searchTimer);
    void runSearch(searchQuery.value.trim(), lyricsQuery.value.trim());
    return;
  }
  albumLoadRequest++;
  albumLoadPromise = null;
  songLoadRequest++;
  songLoadPromise = null;
  allAlbums.value = [];
  albumOffset.value = 0;
  albumsDone.value = false;
  allSongs.value = [];
  songOffset.value = 0;
  songsDone.value = false;
  if (tab.value === "albums") void ensureAlbumItems(pageSize.value + 1);
  if (tab.value === "songs") void ensureSongItems(pageSize.value + 1);
});

const SEARCH_DEBOUNCE_MS = 300;
const searchQuery = ref(!props.embedded && typeof route.query.q === "string" ? route.query.q : "");
const lyricsQuery = ref(!props.embedded && typeof route.query.lyrics === "string" ? route.query.lyrics : "");
const extendedSearchOpen = ref(!!lyricsQuery.value);
const searching = ref(false);
const searchResults = ref<{ artists: Artist[]; albums: Album[]; songs: Track[] } | null>(null);
const searchAlbumDisplayCards = computed<AlbumDisplayCard<Album>[]>(() =>
  foldAlbumDisplayCards(searchAlbumRows.value, displayGroups.value)
);
const pagedSearchAlbumDisplayCards = computed(() => searchAlbumDisplayCards.value.slice((searchPages.value.albums - 1) * pageSize.value, searchPages.value.albums * pageSize.value));
const pagedSearchSongs = computed(() => searchSongRows.value.slice((searchPages.value.songs - 1) * pageSize.value, searchPages.value.songs * pageSize.value));
const searchError = ref("");
const isSearchActive = computed(() => !!searchQuery.value.trim() || !!lyricsQuery.value.trim());
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchRequest = 0;
let searchController: AbortController | null = null;

function searchProtocolError(xml: string): { code: string; message: string } | null {
  if (!xml || !/(?:status=["']failed["']|<error\b)/i.test(xml)) return null;
  const error = parseXmlAttrs(xml, "error")[0];
  return { code: error?.code || "", message: error?.message || xml };
}

function lyricsSearchIsPreparing(error: { code: string; message: string }): boolean {
  return /edgeSonicLyricsSearchInitializing/i.test(`${error.code} ${error.message}`);
}

function resetSearchPages() {
  searchDataRequest++;
  searchAlbumRows.value = [];
  searchAlbumOffset.value = 0;
  searchAlbumsDone.value = false;
  searchSongRows.value = [];
  searchSongOffset.value = 0;
  searchSongsDone.value = false;
  searchPages.value = { artists: 1, albums: 1, songs: 1 };
  searchHasMore.value = { artists: false, albums: false, songs: false };
}

async function ensureSearchAlbums(target: number, query: string, lyricQuery: string, signal: AbortSignal, request: number) {
  if (lyricQuery) { searchAlbumsDone.value = true; return; }
  while (!searchAlbumsDone.value && searchAlbumDisplayCards.value.length < target) {
    const count = Math.min(200, Math.max(pageSize.value, target - searchAlbumDisplayCards.value.length));
    const params = buildLibrarySearchParams(query, lyricQuery, sortMode.value, pageSize.value, searchPages.value);
    params.artistCount = "0";
    params.albumCount = String(count);
    params.albumOffset = String(searchAlbumOffset.value);
    params.songCount = "0";
    const xml = await authFetch("search3", params, signal);
    if (request !== searchDataRequest || signal.aborted) return;
    const protocolError = searchProtocolError(xml);
    if (protocolError) throw new Error(protocolError.message);
    const page = parseXmlAttrs(xml, "album").map((a) => ({
      id: a.id || "", name: a.name || "", artist: a.artist || "", year: a.year || "",
      coverArt: a.coverArt || "", songCount: a.songCount || "", starred: !!a.starred,
      starredAt: a.starred || undefined, createdAt: a.created || undefined,
    }));
    searchAlbumRows.value.push(...page);
    searchAlbumOffset.value += page.length;
    if (page.length < count) searchAlbumsDone.value = true;
  }
}

async function ensureSearchSongs(target: number, query: string, lyricQuery: string, signal: AbortSignal, request: number) {
  while (!searchSongsDone.value && searchSongRows.value.length < target) {
    const count = Math.min(200, Math.max(pageSize.value, target - searchSongRows.value.length));
    const params = buildLibrarySearchParams(query, lyricQuery, sortMode.value, pageSize.value, searchPages.value);
    params.artistCount = "0";
    params.albumCount = "0";
    params.songCount = String(count);
    params.songOffset = String(searchSongOffset.value);
    const xml = await authFetch("search3", params, signal);
    if (request !== searchDataRequest || signal.aborted) return;
    const protocolError = searchProtocolError(xml);
    if (protocolError) throw new Error(protocolError.message);
    const page = parseXmlAttrs(xml, "song").map(mapSongRow);
    searchSongRows.value.push(...(hideInstrumental.value ? page.filter((song) => !isInstrumentalTitle(song.title)) : page));
    searchSongOffset.value += page.length;
    if (page.length < count) searchSongsDone.value = true;
  }
}

async function runSearch(query: string, lyricQuery = lyricsQuery.value.trim()) {
  if (props.embedded) return;
  const request = ++searchRequest;
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  const dataRequest = ++searchDataRequest;
  searching.value = true;
  searchError.value = "";
  // Drop any drilldown so the page-header title/breadcrumb don't show stale
  // artist/album context behind the search results view.
  detailRequest++;
  currentArtist.value = null;
  currentAlbum.value = null;
  currentDisplayGroup.value = null;
  try {
    const pages = searchPages.value;
    const params = buildLibrarySearchParams(query, lyricQuery, sortMode.value, pageSize.value, pages);
    params.albumCount = "0";
    params.songCount = "0";
    const [xml] = await Promise.all([
      authFetch("search3", params, controller.signal),
      ensureAlbumDisplayGroups(),
    ]);
    if (request !== searchRequest) return;
    const protocolError = searchProtocolError(xml);
    if (protocolError) {
      searchResults.value = null;
      searchError.value = lyricQuery && lyricsSearchIsPreparing(protocolError)
        ? t("library.lyricsSearchPreparing")
        : t("library.searchFailed");
      searching.value = false;
      return;
    }
    const artists = parseXmlAttrs(xml, "artist").map((a) => ({
        id: a.id || "", name: a.name || "", albumCount: a.albumCount || "",
        starred: !!a.starred, starredAt: a.starred || undefined, createdAt: a.created || undefined,
      }));
    const hasMore = {
      artists: artists.length > pageSize.value,
      albums: false,
      songs: false,
    };
    if (pageSize.value === 500) {
      const lookAheadArtists = async () => {
        const params = buildLibrarySearchParams(query, lyricQuery, sortMode.value, pageSize.value, pages);
        params.artistCount = "1";
        params.albumCount = "0";
        params.songCount = "0";
        params.artistOffset = String(pages.artists * pageSize.value);
        const response = await authFetch("search3", params, controller.signal);
        if (searchProtocolError(response)) throw new Error("Search page lookahead failed");
        return parseXmlAttrs(response, "artist").length > 0;
      };
      if (artists.length === pageSize.value && !lyricQuery) hasMore.artists = await lookAheadArtists();
    }
    if (request !== searchRequest) return;
    searchResults.value = {
      artists: artists.slice(0, pageSize.value),
      albums: searchAlbumRows.value,
      songs: searchSongRows.value,
    };
    await Promise.all([
      ensureSearchAlbums(searchPages.value.albums * pageSize.value + 1, query, lyricQuery, controller.signal, dataRequest),
      ensureSearchSongs(searchPages.value.songs * pageSize.value + 1, query, lyricQuery, controller.signal, dataRequest),
    ]);
    if (request !== searchRequest || controller.signal.aborted) return;
    searchResults.value.albums = searchAlbumRows.value;
    searchResults.value.songs = searchSongRows.value;
    hasMore.albums = searchAlbumDisplayCards.value.length > searchPages.value.albums * pageSize.value;
    hasMore.songs = searchSongRows.value.length > searchPages.value.songs * pageSize.value;
    searchHasMore.value = hasMore;
    searchResults.value = {
      artists: artists.slice(0, pageSize.value),
      albums: searchAlbumRows.value,
      songs: searchSongRows.value,
    };
  } catch {
    if (controller.signal.aborted) return;
    if (request !== searchRequest) return;
    searchResults.value = null;
    searchError.value = t("library.searchFailed");
  }
  if (request === searchRequest) searching.value = false;
}

async function setSearchPage(kind: "artists" | "albums" | "songs", page: number) {
  const target = Math.max(1, Math.floor(page));
  if (target === searchPages.value[kind] || (target > searchPages.value[kind] && !searchHasMore.value[kind])) return;
  searchPages.value = { ...searchPages.value, [kind]: target };
  await runSearch(searchQuery.value.trim(), lyricsQuery.value.trim());
  const results = kind === "albums" ? pagedSearchAlbumDisplayCards.value
    : kind === "songs" ? pagedSearchSongs.value
    : searchResults.value?.artists ?? [];
  if (!searching.value && !results.length && target > 1) {
    searchPages.value = { ...searchPages.value, [kind]: target - 1 };
    await runSearch(searchQuery.value.trim(), lyricsQuery.value.trim());
  }
}

function updateSearchRoute(query: string, lyricQuery: string) {
  const nextQuery = buildLibrarySearchRoute(route.query, query, lyricQuery);
  const currentQuery = typeof route.query.q === "string" ? route.query.q : "";
  const currentLyrics = typeof route.query.lyrics === "string" ? route.query.lyrics : "";
  if (currentQuery === query && currentLyrics === lyricQuery) return;
  void router.replace({ query: nextQuery });
}

watch(() => route.query.q, (q) => {
  if (props.embedded) return;
  const query = typeof q === "string" ? q : "";
  if (searchQuery.value !== query) searchQuery.value = query;
}, { immediate: true });

watch(() => route.query.lyrics, (q) => {
  if (props.embedded) return;
  const query = typeof q === "string" ? q : "";
  if (lyricsQuery.value !== query) lyricsQuery.value = query;
  extendedSearchOpen.value = !!query || extendedSearchOpen.value;
}, { immediate: true });

watch([searchQuery, lyricsQuery], ([q, lyricQ]) => {
  if (props.embedded) return;
  if (searchTimer) clearTimeout(searchTimer);
  const query = q.trim();
  const lyricQuery = lyricQ.trim();
  resetSearchPages();
  searchRequest++;
  searchController?.abort();
  searchController = null;
  if (!query && !lyricQuery) {
    searching.value = false;
    searchError.value = "";
    searchResults.value = null;
    updateSearchRoute("", "");
    return;
  }
  updateSearchRoute(query, lyricQuery);
  searching.value = true;
  searchError.value = "";
  searchTimer = setTimeout(() => void runSearch(query, lyricQuery), SEARCH_DEBOUNCE_MS);
}, { immediate: true });

watch(pageSize, () => {
  listPage.value = 1;
  if (isSearchActive.value) {
    resetSearchPages();
    void runSearch(searchQuery.value.trim(), lyricsQuery.value.trim());
  } else if (!starredOnly && tab.value === "albums") {
    void ensureAlbumItems(pageSize.value + 1);
  } else if (!starredOnly && tab.value === "songs") {
    void ensureSongItems(pageSize.value + 1);
  }
});

watch(() => starredOnly
  ? tab.value === "artists" ? artistRows.value.length
  : tab.value === "albums" ? albumRows.value.length : songRows.value.length
  : null, (length) => {
  if (length === null) return;
  listPage.value = Math.min(listPage.value, Math.max(1, Math.ceil(length / pageSize.value)));
});

function clearSearch() {
  searchQuery.value = "";
  lyricsQuery.value = "";
  extendedSearchOpen.value = false;
}

function toggleExtendedSearch() {
  extendedSearchOpen.value = !extendedSearchOpen.value;
  if (!extendedSearchOpen.value) lyricsQuery.value = "";
  void nextTick(() => {
    if (extendedSearchOpen.value) document.getElementById("library-lyrics-search")?.focus();
    else document.getElementById("library-extended-search-toggle")?.focus();
  });
}

function retrySearch() {
  const query = searchQuery.value.trim();
  const lyricQuery = lyricsQuery.value.trim();
  if (query || lyricQuery) void runSearch(query, lyricQuery);
}

function playFromSearch(i: number) {
  player.setQueue(searchSongRows.value, (searchPages.value.songs - 1) * pageSize.value + i);
}

async function openArtist(artist: Artist) {
  if (!props.embedded) {
    detail.openArtist(artist.id);
    return;
  }
  const request = ++detailRequest;
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  error.value = "";
  currentArtist.value = artist;
  currentAlbum.value = null;
  songs.value = [];
  artistInfo.value = null;
  artistInfoError.value = "";
  loading.value = true;
  void loadArtistInfo(artist, controller.signal);
  try {
    const xml = await authFetch("getArtist", { id: artist.id }, controller.signal);
    if (request !== detailRequest) return;
    const root = parseXmlAttrs(xml, "artist")[0];
    if (!root?.id || /status=["']failed["']/.test(xml)) throw new Error("artist unavailable");
    currentArtist.value = {
      ...artist,
      name: root.name || artist.name,
      albumCount: root.albumCount || artist.albumCount,
      starred: !!root.starred,
      starredAt: root.starred || artist.starredAt,
    };
    albums.value = parseXmlAttrs(xml, "album").map((a) => ({
      id: a.id || "", name: a.name || a.title || "", artist: a.artist || artist.name,
      year: a.year || "", coverArt: a.coverArt || "", songCount: a.songCount || "",
      starred: !!a.starred, starredAt: a.starred || undefined, createdAt: a.created || undefined,
    }));
  } catch {
    if (request === detailRequest && !controller.signal.aborted) { albums.value = []; error.value = t("library.loadFailed"); }
  } finally {
    if (request === detailRequest) loading.value = false;
  }
}

async function loadArtistInfo(artist: Artist, signal?: AbortSignal) {
  const request = ++artistInfoRequest;
  artistInfoLoading.value = true;
  artistInfoError.value = "";
  try {
    const xml = await authFetch("getArtistInfo", { id: artist.id, count: "1" }, signal);
    if (/status="failed"/.test(xml)) throw new Error("artist info unavailable");
    if (request !== artistInfoRequest) return;
    const info: ArtistInfo = {
      biography: artistInfoField(xml, "biography"),
      imageUrl: artistInfoField(xml, "largeImageUrl") || artistInfoField(xml, "mediumImageUrl"),
      lastFmUrl: artistInfoField(xml, "lastFmUrl"),
      mbid: artistInfoField(xml, "musicBrainzId"),
    };
    artistInfo.value = info.biography || info.imageUrl || info.lastFmUrl || info.mbid ? info : null;
    if (!artistInfo.value) artistInfoError.value = t("library.artistInfoUnavailable");
  } catch {
    if (request === artistInfoRequest) artistInfoError.value = t("library.artistInfoUnavailable");
  } finally {
    if (request === artistInfoRequest) artistInfoLoading.value = false;
  }
}

async function openAlbum(album: Album) {
  groupDetailRequest++;
  currentDisplayGroup.value = null;
  if (!props.embedded) {
    detail.openAlbum(album.id);
    return;
  }
  const request = ++detailRequest;
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  error.value = "";
  currentAlbum.value = album;
  loading.value = true;
  try {
    const xml = await authFetch("getAlbum", { id: album.id }, controller.signal);
    if (request !== detailRequest) return;
    const root = parseXmlAttrs(xml, "album")[0];
    if (!root?.id || /status=["']failed["']/.test(xml)) throw new Error("album unavailable");
    currentAlbum.value = {
      ...album,
      name: root.name || album.name,
      artist: root.artist || album.artist,
      year: root.year || album.year,
      coverArt: root.coverArt || album.coverArt,
      songCount: root.songCount || album.songCount,
      starred: !!root.starred,
      starredAt: root.starred || album.starredAt,
      createdAt: root.created || album.createdAt,
    };
    songs.value = parseXmlAttrs(xml, "song").map((s) => ({
      id: s.id || "",
      title: s.title || "",
      artist: s.artist || root.artist || album.artist,
      album: s.album || root.name || album.name,
      coverArt: s.coverArt || root.coverArt || album.coverArt || undefined,
      duration: parseInt(s.duration || "0"),
      starred: !!s.starred,
      starredAt: s.starred || undefined,
      createdAt: s.created || undefined,
      artistId: s.artistId || undefined,
      albumId: s.albumId || root.id || album.id,
    }));
  } catch {
    if (request === detailRequest && !controller.signal.aborted) { songs.value = []; error.value = t("library.loadFailed"); }
  } finally {
    if (request === detailRequest) loading.value = false;
  }
}

function playSong(i: number) {
  player.setQueue(albumSongs.value, i);
}

function playFromAll(i: number) {
  player.setQueue(songRows.value, (listPage.value - 1) * pageSize.value + i);
}

function playFromStarred(i: number) {
  player.setQueue(songRows.value, (listPage.value - 1) * pageSize.value + i);
}

function playAlbumFromStart() {
  if (albumSongs.value.length) player.setQueue(albumSongs.value, 0);
}

function queueNext(song: Track) {
  player.playNext(song);
  showInfo(t("library.queuedNext", { title: song.title }));
}

async function openAlbumById(albumId: string, albumName: string) {
  const album: Album = { id: albumId, name: albumName, artist: "", year: "", coverArt: "", songCount: "", starred: false };
  await openAlbum(album);
}

async function openArtistById(artistId: string, artistName: string) {
  const artist: Artist = { id: artistId, name: artistName, albumCount: "", starred: false };
  await openArtist(artist);
}

async function openSongInFiles(song: Track) {
  if (!canManageFiles.value) return;
  try {
    const xml = await authFetch("getSong", { id: song.id, includeSources: "true" });
    const attrs = parseXmlAttrs(xml, "song")[0];
    const filePath = attrs?.path?.replace(/^\/+|\/+$/g, "") || "";
    if (!filePath) {
      showInfo(t("library.fileLocationUnavailable"));
      return;
    }
    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
    const folder = filePath.substring(0, filePath.lastIndexOf("/"));
    const sourceAttr = parseXmlAttrs(xml, "source")[0];
    const source = sourceAttr?.sourceId && sourceAttr.sourceId !== "r2-local"
      ? sourceAttr.sourceId
      : "r2";
    await router.push({ path: "/files", query: { source, path: folder, file: fileName } });
  } catch {
    showInfo(t("library.fileLocationUnavailable"));
  }
}

function parseArtists(artistStr: string): string[] {
  return artistStr.split(/,|;/).map(a => a.trim()).filter(a => a.length > 0);
}

async function searchAndOpenArtist(artistName: string) {
  const query = artistName.trim();
  if (!query) return;
  resetSearchPages();
  await runSearch(query, "");
  const matches = searchResults.value?.artists || [];
  if (matches.length > 0) {
    await openArtist(matches[0]);
    clearSearch();
  }
}

type StarEntity = Artist | Album | Track;
type StarKind = "artist" | "album" | "song";

function removeStarred(kind: StarKind, id: string) {
  if (kind === "artist") starredLists.value.artists = starredLists.value.artists.filter((item) => item.id !== id);
  else if (kind === "album") starredLists.value.albums = starredLists.value.albums.filter((item) => item.id !== id);
  else starredLists.value.songs = starredLists.value.songs.filter((item) => item.id !== id);
}

function onStarChanged(kind: StarKind, item: StarEntity, value: boolean) {
  if (kind === "song") {
    const songId = item.id;
    const songLists: Track[][] = [
      allSongs.value,
      songs.value,
      starredLists.value.songs,
      searchResults.value?.songs ?? [],
    ];
    for (const list of songLists) {
      for (const song of list) {
        if (song.id === songId) song.starred = value;
      }
    }
    player.setStarred(songId, value);
  } else {
    item.starred = value;
  }
  if (starredOnly && !value) removeStarred(kind, item.id);
  detail.notifyStarChange(kind, item.id, value);
}

watch(() => detail.starChange, (change) => {
  if (!change) return;
  const rows: StarEntity[] = change.kind === "song"
    ? [...allSongs.value, ...songs.value, ...starredLists.value.songs, ...(searchResults.value?.songs ?? [])]
    : change.kind === "album"
      ? [...allAlbums.value, ...albums.value, ...starredLists.value.albums, ...(searchResults.value?.albums ?? []), ...(currentAlbum.value ? [currentAlbum.value] : [])]
      : [...artists.value, ...starredLists.value.artists, ...(searchResults.value?.artists ?? []), ...(currentArtist.value ? [currentArtist.value] : [])];
  for (const item of rows) if (item.id === change.id) item.starred = change.starred;
  if (starredOnly && !change.starred) removeStarred(change.kind, change.id);
});

function onStarError() {
  error.value = t("library.starUpdateFailed");
}

const editTargets = ref<Track[]>([]);
const editInitial = ref<Record<string, string | number>>({});
const editBusy = ref(false);
const editMsg = ref("");
const editErr = ref(false);
const editorOpen = ref(false);
const editorMode = computed<"single" | "batch">(() => editTargets.value.length > 1 ? "batch" : "single");
const editExistingCoverUrl = computed(() => {
  if (editorMode.value !== "single") return undefined;
  const coverArt = editTargets.value[0]?.coverArt;
  return coverArt ? coverArtUrl(coverArt, 200) : undefined;
});

const editMode = ref(false);
function toggleEditMode() {
  editMode.value = !editMode.value;
  if (!editMode.value) clearSelection();
}

async function openEditor(s: Track) {
  editTargets.value = [s];
  editMsg.value = ""; editErr.value = false;
  // seed with the list-row data, then enrich from getSong for genre/year/track
  editInitial.value = { title: s.title, artist: s.artist, album: s.album };
  editorOpen.value = true;
  try {
    const xml = await authFetch("getSong", { id: s.id });
    const full = parseXmlAttrs(xml, "song")[0];
    if (full && editTargets.value[0]?.id === s.id) {
      editInitial.value = {
        title: full.title || s.title,
        artist: full.artist || s.artist,
        album: full.album || s.album,
        albumArtist: full.albumArtist || "",
        genre: full.genre || "",
        year: full.year || "",
        track: full.track || "",
        disc: full.discNumber || "",
      };
    }
  } catch { /* prefill stays partial */ }
}

function openBatchEditor() {
  if (!selectedIds.value.length) return;
  const lookup = new Map(allSongs.value.map((s) => [s.id, s]));
  editTargets.value = selectedIds.value.map((id) => lookup.get(id)).filter(Boolean) as Track[];
  editInitial.value = {};
  editMsg.value = ""; editErr.value = false;
  editorOpen.value = true;
}

const rescanBusy = ref(false);
const rescanMsg = ref("");
async function batchRescan() {
  if (!selectedIds.value.length || rescanBusy.value) return;
  rescanBusy.value = true;
  rescanMsg.value = "";
  try {
    const res = await rescanSongs(selectedIds.value);
    if (res.ok) {
      rescanMsg.value = t("library.rescanQueued", { n: res.dispatched ?? 0 });
      clearSelection();
    } else {
      rescanMsg.value = `${t("library.rescanFailed")}: ${res.error || "unknown"}`;
    }
  } catch (e) {
    rescanMsg.value = `${t("library.rescanFailed")}: ${e instanceof Error ? e.message : String(e)}`;
  }
  rescanBusy.value = false;
  setTimeout(() => { rescanMsg.value = ""; }, 5000);
}

function closeEditor() {
  editorOpen.value = false;
  // keep targets briefly so the modal slide-out reads consistent state; reset on next open.
}

function scrapeQueryFromForm(form: Record<string, string>): string {
  const t1 = (form.title || "").trim();
  const a1 = (form.artist || "").trim();
  if (t1 || a1) return [t1, a1].filter(Boolean).join(" ");
  const init = editInitial.value;
  return [init.title, init.artist].filter(Boolean).join(" ");
}

async function applyScrapeResult(
  form: Record<string, string>,
  applyFlags: Record<string, boolean>,
  r: ScrapeResult,
  applyCoverUrl: (url: string) => Promise<void>,
) {
  if (r.coverUrl) {
    try { await applyCoverUrl(r.coverUrl); } catch { /* TagEditor keeps coverError visible; continue with metadata. */ }
  }
  if (r.title) form.title = r.title;
  if (r.artist) form.artist = r.artist;
  if (r.albumArtist) form.albumArtist = r.albumArtist;
  if (r.album) form.album = r.album;
  if (r.year) form.year = String(r.year);
  if (r.lyrics) form.lyrics = r.lyrics;
  // Touch the apply flags for batch mode UX parity (no-op in single mode).
  if (r.title) applyFlags.title = true;
  if (r.artist) applyFlags.artist = true;
  if (r.albumArtist) applyFlags.albumArtist = true;
  if (r.album) applyFlags.album = true;
  if (r.year) applyFlags.year = true;
  if (r.lyrics) applyFlags.lyrics = true;
}

async function onEditorSubmit(patch: Record<string, string | number>, cover?: { data: string; mime: string }) {
  if (!editTargets.value.length || (!Object.keys(patch).length && !cover)) return;
  editBusy.value = true; editMsg.value = ""; editErr.value = false;

  try {
    if (editorMode.value === "single") {
      const target = editTargets.value[0];
      const res = await writeTags(target.id, patch, cover);
      if (!res.ok) {
        editErr.value = true;
        editMsg.value = res.error || t("library.editFailed");
      } else {
        // reflect changes in the open list without a full reload
        if (typeof patch.title === "string") target.title = patch.title;
        if (typeof patch.artist === "string") target.artist = patch.artist;
        if (typeof patch.album === "string") target.album = patch.album;
        const files = res.files || [];
        const written = files.filter((x) => x.written).length;
        const skipped = files.filter((x) => !x.written).map((x) => x.reason).filter(Boolean);
        editErr.value = skipped.length > 0;
        editMsg.value = t("library.editSaved", { written, total: files.length })
          + (skipped.length ? ` (${skipped.join("; ")})` : "");
      }
    } else {
      const ids = editTargets.value.map((t) => t.id);
      const res = await batchWriteTags(ids, patch, cover);
      if (!res.ok) {
        editErr.value = true;
        editMsg.value = res.error || t("tagEditor.batchFailed");
      } else {
        const fileFailures = (res.results || []).flatMap((r) => (r.files || []).filter((f) => !f.written).map((f) => f.reason || "write skipped"));
        const totalFailures = (res.failed ?? 0) + fileFailures.length;
        editErr.value = totalFailures > 0;
        editMsg.value = t("tagEditor.batchSaved", { succeeded: res.succeeded ?? 0, failed: totalFailures })
          + (fileFailures.length ? ` (${fileFailures.slice(0, 3).join("; ")})` : "");
        // optimistic local update for batched fields
        for (const target of editTargets.value) {
          if (typeof patch.title === "string") target.title = patch.title;
          if (typeof patch.artist === "string") target.artist = patch.artist;
          if (typeof patch.album === "string") target.album = patch.album;
        }
        if (!totalFailures) selectedIds.value = [];
      }
    }
  } catch {
    editErr.value = true;
    editMsg.value = editorMode.value === "batch" ? t("tagEditor.batchFailed") : t("library.editFailed");
  }
  editBusy.value = false;
}

const selectedIds = ref<string[]>([]);
const selectedSet = computed(() => new Set(selectedIds.value));

function toggleSelected(id: string) {
  const idx = selectedIds.value.indexOf(id);
  if (idx >= 0) selectedIds.value.splice(idx, 1);
  else selectedIds.value.push(id);
}
function clearSelection() { selectedIds.value = []; }

function backToList() {
  if (props.embedded) {
    detail.close();
    return;
  }
  detailRequest++;
  groupDetailRequest++;
  currentArtist.value = null;
  currentAlbum.value = null;
  currentDisplayGroup.value = null;
  albums.value = [];
  songs.value = [];
  artistInfo.value = null;
  artistInfoError.value = "";
  artistInfoRequest++;
}

function backToAlbums() {
  detailController?.abort();
  if (props.embedded && !currentArtist.value && !currentDisplayGroup.value) {
    detail.close();
    return;
  }
  detailRequest++;
  groupDetailRequest++;
  currentAlbum.value = null;
  currentDisplayGroup.value = null;
  songs.value = [];
  error.value = "";
}

function retryDetail() {
  if (currentAlbum.value) void openAlbum(currentAlbum.value);
  else if (currentArtist.value) void openArtist(currentArtist.value);
}

const songsHintFaded = ref(false);

onMounted(() => {
  if (props.detailTarget) {
    if (props.detailTarget.kind === "artist") {
      void openArtist({ id: props.detailTarget.id, name: "", albumCount: "", starred: false });
    } else {
      void openAlbum({ id: props.detailTarget.id, name: "", artist: "", year: "", coverArt: "", songCount: "", starred: false });
    }
    return;
  }
  if (starredOnly) void loadStarred();
  else if (tab.value === "artists") loadArtists();
  else if (tab.value === "albums") void ensureAlbumItems(pageSize.value + 1);
  else void ensureSongItems(pageSize.value + 1);
  setTimeout(() => { songsHintFaded.value = true; }, 5000);
});

watch(() => player.starred, () => {
  const currentId = player.current?.id;
  if (currentId) {
    const rows = [
      ...allSongs.value,
      ...starredLists.value.songs,
      ...(searchResults.value?.songs ?? []),
    ];
    const row = rows.find((item) => item.id === currentId);
    if (row) row.starred = player.starred;
  }
  if (starredOnly) void loadStarred(true);
});
watch(() => player.current?.id, () => { locateRetryId = null; });

onUnmounted(() => {
  detailController?.abort();
  if (waterfallRO) { waterfallRO.disconnect(); waterfallRO = null; }
  if (searchTimer) clearTimeout(searchTimer);
  searchController?.abort();
  searchController = null;
});

const shareOpen = ref(false);
const shareSongIds = ref<string[]>([]);
const shareLabel = ref("");
const sharePreparing = ref(false);
const clearSelectionAfterShare = ref(false);

function openShareWithIds(ids: string[], label: string, options?: { clearSelection?: boolean }) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (!uniqueIds.length) {
    showInfo(t("library.shareCreateFailed"));
    return;
  }
  clearSelectionAfterShare.value = options?.clearSelection === true;
  shareSongIds.value = uniqueIds;
  shareLabel.value = label;
  shareOpen.value = true;
}

async function openShare(kind: "song" | "album", id: string, label: string) {
  if (sharePreparing.value) return;
  sharePreparing.value = true;
  try {
    const ids = kind === "album" ? await resolveAlbumSongIds(id) : [id];
    openShareWithIds(ids, label);
  } catch {
    showInfo(t("library.shareCreateFailed"));
  } finally {
    sharePreparing.value = false;
  }
}

function openBatchShare() {
  openShareWithIds(selectedIds.value, t("library.selected", { n: selectedIds.value.length }), { clearSelection: true });
}
function closeShare() {
  shareOpen.value = false;
  shareSongIds.value = [];
  shareLabel.value = "";
  clearSelectionAfterShare.value = false;
}
function onShareCreated() {
  if (clearSelectionAfterShare.value) clearSelection();
}
// Album ids can collide with song ids (albums cloned from an upstream Subsonic
// server carry bare numeric ids that overlap the song_master id space), so the
// share API can't reliably tell an album target from a song target. Resolve an
// album to its song ids here, where the intent (kind === "album") is known.
async function resolveAlbumSongIds(albumId: string): Promise<string[]> {
  const xml = await authFetch("getAlbum", { id: albumId });
  return parseXmlAttrs(xml, "song").map((s) => s.id || "").filter(Boolean);
}


interface AddPlaylistRow {
  id: string;
  name: string;
  songCount: string;
}
const addPlaylistOpen = ref(false);
const addPlaylistTarget = ref<{ id: string; title: string } | null>(null);
const addPlaylistList = ref<AddPlaylistRow[]>([]);
const addPlaylistLoading = ref(false);
const addPlaylistBusy = ref(false);
const addPlaylistMessage = ref("");
const addPlaylistError = ref("");
const addPlaylistCreating = ref(false);
const addPlaylistNewName = ref("");

async function openAddToPlaylist(songId: string, title: string) {
  addPlaylistTarget.value = { id: songId, title };
  addPlaylistOpen.value = true;
  addPlaylistMessage.value = "";
  addPlaylistError.value = "";
  addPlaylistCreating.value = false;
  addPlaylistNewName.value = "";
  addPlaylistLoading.value = true;
  try {
    const xml = await authFetch("getPlaylists");
    addPlaylistList.value = parseXmlAttrs(xml, "playlist").map((p) => ({
      id: p.id || "",
      name: p.name || "",
      songCount: p.songCount || "0",
    }));
  } catch {
    addPlaylistList.value = [];
  } finally {
    addPlaylistLoading.value = false;
  }
}
function closeAddToPlaylist() {
  addPlaylistOpen.value = false;
  addPlaylistTarget.value = null;
  addPlaylistMessage.value = "";
  addPlaylistError.value = "";
  addPlaylistCreating.value = false;
}
async function addSongToPlaylist(playlistId: string) {
  if (!addPlaylistTarget.value) return;
  addPlaylistBusy.value = true;
  addPlaylistError.value = "";
  addPlaylistMessage.value = "";
  try {
    const xml = await authFetch("updatePlaylist", {
      playlistId,
      songIdToAdd: addPlaylistTarget.value.id,
    });
    if (/status="failed"/.test(xml)) {
      const m = /<error[^>]+message="([^"]+)"/.exec(xml);
      throw new Error(m?.[1] || "add failed");
    }
    addPlaylistMessage.value = t("library.addedToPlaylist");
    // Brief delay so the user sees the confirmation, then auto-close.
    setTimeout(() => { if (addPlaylistOpen.value) closeAddToPlaylist(); }, 900);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addPlaylistError.value = `${t("library.addToPlaylistFailed")}: ${msg}`;
  } finally {
    addPlaylistBusy.value = false;
  }
}
function beginCreateNew() {
  addPlaylistCreating.value = true;
  addPlaylistNewName.value = "";
  addPlaylistError.value = "";
}
async function submitCreateAndAdd() {
  if (!addPlaylistTarget.value) return;
  const name = addPlaylistNewName.value.trim();
  if (!name) {
    addPlaylistError.value = t("library.addToPlaylistFailed");
    return;
  }
  addPlaylistBusy.value = true;
  addPlaylistError.value = "";
  try {
    const xml = await authFetch("createPlaylist", {
      name,
      songId: addPlaylistTarget.value.id,
    });
    if (/status="failed"/.test(xml)) {
      const m = /<error[^>]+message="([^"]+)"/.exec(xml);
      throw new Error(m?.[1] || "create failed");
    }
    addPlaylistMessage.value = t("library.addedToPlaylist");
    setTimeout(() => { if (addPlaylistOpen.value) closeAddToPlaylist(); }, 900);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addPlaylistError.value = `${t("library.addToPlaylistFailed")}: ${msg}`;
  } finally {
    addPlaylistBusy.value = false;
  }
}

const openMenuId = ref<string | null>(null);
function toggleRowMenu(id: string) {
  openMenuId.value = openMenuId.value === id ? null : id;
}
function closeRowMenu() {
  openMenuId.value = null;
}
const optionsOpen = ref(false);
function toggleOptions() {
  optionsOpen.value = !optionsOpen.value;
}
function onWindowClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (openMenuId.value && !target.closest(".row-menu-wrap, .row-menu")) closeRowMenu();
  if (optionsOpen.value && !target.closest(".list-options-wrap, .list-options-menu")) optionsOpen.value = false;
}
onMounted(() => window.addEventListener("click", onWindowClick));
onUnmounted(() => window.removeEventListener("click", onWindowClick));
</script>

<template>
  <div class="library" :class="{ 'library--embedded': embedded }">
    <div class="page-header" :class="{ 'media-detail-heading': embedded }">
      <BudgetedImage v-if="embedded && currentAlbum?.coverArt" :key="currentAlbum.coverArt" class="media-detail-cover" :src="coverArtUrl(currentAlbum.coverArt, 256)" :alt="currentAlbum.name" @error="currentAlbum.coverArt = ''" />
      <div class="media-detail-titles">
        <div class="mono-label breadcrumb">
          <a @click="backToList">{{ starredOnly ? t("library.starredBreadcrumb") : t("library.breadcrumb") }}</a>
          <template v-if="currentDisplayGroup"> / <span>{{ currentDisplayGroup.name }}</span></template>
          <template v-if="currentArtist"> / <a @click="backToAlbums">{{ currentArtist.name }}</a></template>
          <template v-if="currentAlbum"> / <span>{{ currentAlbum.name }}</span></template>
        </div>
        <h1 class="page-title">{{ currentAlbum?.name || currentDisplayGroup?.name || currentArtist?.name || (starredOnly ? t("library.starredTitle") : t("library.title")) }}</h1>
      </div>
      <div v-if="currentArtist || currentAlbum" class="detail-actions">
        <StarButton
          v-if="currentArtist && !currentAlbum"
          :id="currentArtist.id"
          kind="artist"
          :starred="currentArtist.starred"
          @update:starred="onStarChanged('artist', currentArtist, $event)"
          @error="onStarError"
        />
        <StarButton
          v-if="currentAlbum"
          :id="currentAlbum.id"
          kind="album"
          :starred="currentAlbum.starred"
          @update:starred="onStarChanged('album', currentAlbum, $event)"
          @error="onStarError"
        />
        <button v-if="currentAlbum && albumSongs.length" class="btn-primary" @click="playAlbumFromStart"><Icon name="play" /> {{ t("library.playAlbum") }}</button>
        <ListOptionsMenu
          v-if="currentAlbum"
          :open="optionsOpen"
          v-model:hide-instrumental="hideInstrumental"
          @toggle="toggleOptions"
          @close="optionsOpen = false"
        />
      </div>
      <div v-else-if="starredOnly && canShare" class="detail-actions">
        <button
          class="btn-secondary"
          :disabled="!starredLists.songs.length"
          @click="openShareWithIds(starredLists.songs.map((song) => song.id), t('library.starredTitle'))"
        ><Icon name="up" /> {{ t("library.share") }}</button>
      </div>
    </div>

    <!-- Library-wide search — always visible, independent of tabs/drilldown. -->
    <div v-if="!starredOnly && !embedded" class="library-search">
      <div class="primary-search-field">
        <label class="sr-only" for="library-search">{{ t("library.searchLabel") }}</label>
        <input id="library-search" v-model="searchQuery" class="form-input search-input" type="search" :placeholder="t('library.searchPlaceholder')" />
        <button v-if="searchQuery" type="button" class="search-clear" :aria-label="t('library.clearSearch')" :title="t('common.close')" @click="clearSearch"><Icon name="cross" /></button>
      </div>
      <button
        id="library-extended-search-toggle"
        type="button"
        class="btn-secondary btn-sm extended-search-toggle"
        :aria-expanded="extendedSearchOpen"
        aria-controls="library-lyrics-search"
        @click="toggleExtendedSearch"
      >{{ t("library.extendedSearch") }}</button>
      <div v-if="extendedSearchOpen" class="extended-search-panel">
        <label class="sr-only" for="library-lyrics-search">{{ t("library.lyricsSearchLabel") }}</label>
        <input
          id="library-lyrics-search"
          v-model="lyricsQuery"
          class="form-input search-input"
          type="search"
          :placeholder="t('library.lyricsSearchPlaceholder')"
          @keydown.esc="toggleExtendedSearch"
        />
        <button v-if="lyricsQuery" type="button" class="search-clear" :aria-label="t('library.clearLyricsSearch')" :title="t('common.close')" @click="lyricsQuery = ''"><Icon name="cross" /></button>
      </div>
    </div>

    <template v-if="!isSearchActive || currentDisplayGroup">
    <!-- View tabs and sorting (hidden while drilled into an artist/album) -->
    <div v-if="!currentArtist && !currentAlbum && !currentDisplayGroup && !embedded" class="library-controls">
      <div class="view-tabs">
      <button :class="['view-tab', { active: tab === 'songs' }]" @click="switchTab('songs')"><Icon name="music" /> {{ t("library.tabSongs") }}</button>
      <button :class="['view-tab', { active: tab === 'albums' }]" @click="switchTab('albums')"><Icon name="album" /> {{ t("library.tabAlbums") }}</button>
      <button :class="['view-tab', { active: tab === 'artists' }]" @click="switchTab('artists')"><Icon name="users" /> {{ t("library.tabArtists") }}</button>
      </div>
      <label class="sort-control">
        <span class="mono-label">{{ t("library.sortLabel") }}</span>
        <FluentSelect :model-value="sortMode" class="form-input sort-select" :aria-label="t('library.sortLabel')" :options="[{ value: 'newest', label: t(starredOnly ? 'library.sortNewest' : 'library.sortNewestAdded') }, ...(starredOnly ? [{ value: 'oldestStarred', label: t('library.sortOldestStarred') }, { value: 'newestAdded', label: t('library.sortNewestAdded') }] : []), { value: 'oldestAdded', label: t('library.sortOldestAdded') }, { value: 'nameAsc', label: t('library.sortNameAsc') }, { value: 'nameDesc', label: t('library.sortNameDesc') }]" @update:model-value="sortMode = $event as SortMode" />
      </label>
      <label class="page-size-control">
        <span class="mono-label">{{ t("library.pageSize") }}</span>
        <FluentSelect :model-value="String(pageSize)" class="form-input page-size-select" :aria-label="t('library.pageSize')" :options="pageSizeOptions" @update:model-value="pageSize = Number($event) as LibraryPageSize" />
      </label>
      <button class="btn-secondary btn-sm locate-current-btn" :disabled="locatingCurrent" @click="locateCurrentSong">
        {{ locatingCurrent ? t("library.locatingCurrent") : t("library.locateCurrent") }}
      </button>
      <ListOptionsMenu
        v-if="tab === 'songs'"
        :open="optionsOpen"
        v-model:hide-instrumental="hideInstrumental"
        @toggle="toggleOptions"
        @close="optionsOpen = false"
      />
    </div>

    <div v-if="error" class="status-badge error" role="alert">{{ error }}<button v-if="embedded" type="button" class="btn-secondary btn-sm" @click="retryDetail"><Icon name="refresh" />{{ t("common.retry") }}</button></div>

    <!-- Drill-down: songs of an album (any tab) -->
    <!-- The trailing 32px track holds the per-row "⋮" menu (SongRowMenu) —
         `auto` tracks are banned since each .table-row is its own grid, so
         content-sized tracks would misalign across rows. -->
    <div v-if="currentAlbum" class="table-wrap song-table" style="--grid-cols: 36px 2fr 1fr 64px 32px 32px">
      <div class="table-header">
        <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span></span><span></span>
      </div>
      <!-- Album-level share affordance, sits above the track table. -->
       <button v-if="currentAlbum" class="album-share-btn" :title="t('library.share')" @click.stop="openShare('album', currentAlbum.id, currentAlbum.name)"><Icon name="up" /> {{ t("library.share") }}</button>
      <div
        v-for="(s, i) in albumSongs"
        :key="s.id"
        class="table-row song-row"
        :class="{ playing: player.current?.id === s.id }"
        @click="playSong(i)"
      >
       <span class="song-no"><Icon v-if="player.current?.id === s.id && player.playing" name="play" /><template v-else>{{ i + 1 }}</template></span>
        <span class="song-title">{{ s.title }}</span>
          <span class="song-artist-group" :data-album="s.album">
            <template v-for="(artist, idx) in parseArtists(s.artist)" :key="idx">
              <span v-if="idx > 0" class="artist-sep">,</span>
              <span class="song-artist clickable" :class="{ 'has-id': s.artistId }" @click.stop="s.artistId ? openArtistById(s.artistId, artist) : searchAndOpenArtist(artist)">{{ artist }}</span>
            </template>
          </span>
         <span class="song-time">{{ formatDuration(s.duration) }}</span>
         <StarButton
           class="row-like-btn"
           :id="s.id"
           kind="song"
           :starred="!!s.starred"
           @update:starred="onStarChanged('song', s, $event)"
           @error="onStarError"
         />
          <SongRowMenu
            :song-id="s.id"
            :title="s.title"
            :starred="!!s.starred"
            :is-admin="isAdmin"
            :can-manage-files="canManageFiles"
          :open="openMenuId === s.id"
          @toggle="toggleRowMenu(s.id)"
          @close="closeRowMenu"
           @edit="openEditor(s)"
           @share="openShare('song', s.id, s.title)"
           @view-file="openSongInFiles(s)"
           @add-playlist="openAddToPlaylist(s.id, s.title)"
           @play-next="queueNext(s)"
           @update:starred="onStarChanged('song', s, $event)"
           @error="onStarError"
         />
      </div>
      <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>
      <div v-else-if="!albumSongs.length && !error" class="empty-state">{{ t("library.noTracks") }}</div>
    </div>

    <div v-else-if="currentDisplayGroup" class="artist-detail">
      <button class="btn-secondary btn-sm" @click="backToAlbums">{{ t("library.backToAlbums") }}</button>
      <div class="album-grid group-editions">
        <button
          v-for="edition in currentDisplayGroup.editions"
          :key="edition.id"
          type="button"
          class="card hoverable album-card group-edition-card"
          @click="openAlbum(edition)"
        >
          <div class="album-cover">
            <BudgetedImage v-if="edition.coverArt" :src="coverArtUrl(edition.coverArt, 256)" :alt="edition.name" @error="edition.coverArt = ''" />
            <span v-else class="album-cover-placeholder"><Icon name="note" /></span>
          </div>
          <div class="album-body">
            <span class="album-name">{{ edition.name }}</span>
            <span class="mono-label">{{ edition.artist || "—" }}<template v-if="edition.year"> · {{ edition.year }}</template><template v-if="edition.songCount"> · {{ t("library.trackCount", { n: edition.songCount }) }}</template></span>
          </div>
        </button>
      </div>
      <div v-if="groupDetailLoading" class="empty-state">{{ t("common.loading") }}</div>
    </div>

    <!-- Drill-down: albums of an artist -->
    <div v-else-if="currentArtist" class="artist-detail">
      <div class="artist-info card">
        <img
          v-if="artistInfo?.imageUrl"
          class="artist-info-image"
          :src="artistInfo.imageUrl"
          :alt="currentArtist.name"
          loading="lazy"
          @error="artistInfo.imageUrl = ''"
        />
        <div class="artist-info-body">
          <div class="search-section-title">{{ t("library.artistInfoTitle") }}</div>
          <div v-if="artistInfoLoading" class="mono-label">{{ t("library.artistInfoLoading") }}</div>
          <p v-if="artistInfo?.biography" class="artist-biography">{{ artistInfo.biography }}</p>
          <div v-if="artistInfo?.mbid" class="mono-label">MBID: {{ artistInfo.mbid }}</div>
          <a v-if="artistInfo?.lastFmUrl" class="artist-info-link" :href="artistInfo.lastFmUrl" target="_blank" rel="noopener noreferrer">
            {{ t("library.artistInfoOpen") }}
          </a>
          <div v-if="artistInfoError" class="mono-label artist-info-error">{{ artistInfoError }}</div>
        </div>
      </div>
      <div class="album-grid">
      <div v-for="al in albums" :key="al.id" class="card hoverable album-card" @click="openAlbum(al)">
        <div class="album-cover">
          <BudgetedImage v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 256)" :alt="al.name" @error="al.coverArt = ''" />
          <span v-else class="album-cover-placeholder"><Icon name="note" /></span>
        </div>
        <div class="album-body">
          <div class="album-name">{{ al.name }}</div>
          <div class="mono-label">{{ al.year || "—" }}<template v-if="al.songCount"> · {{ t("library.trackCount", { n: al.songCount }) }}</template></div>
         </div>
         <!-- Per-album share. -->
         <StarButton
           class="card-like-btn"
           :id="al.id"
           kind="album"
           :starred="al.starred"
           @update:starred="onStarChanged('album', al, $event)"
           @error="onStarError"
         />
          <button class="card-share-btn" :title="t('library.share')" @click.stop="openShare('album', al.id, al.name)"><Icon name="up" /></button>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
    </div>
      <div v-if="loading" class="empty-state" style="grid-column: 1/-1">{{ t("common.loading") }}</div>
      <div v-else-if="!albums.length" class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon"><Icon name="empty" /></div>
        <div>{{ t("library.noAlbums") }}</div>
      </div>
    </div>

    <!-- Tab: artists -->
    <div v-else-if="tab === 'artists'" class="artist-grid">
      <div v-for="a in displayArtists" :key="a.id" class="card hoverable artist-card" @click="openArtist(a)">
        <div class="artist-glyph">{{ a.name.charAt(0).toUpperCase() || "?" }}</div>
        <div class="artist-name">{{ a.name }}</div>
        <div class="mono-label" v-if="a.albumCount">{{ t("library.albumCount", { n: a.albumCount }) }}</div>
        <StarButton
          class="card-like-btn artist-like-btn"
          :id="a.id"
          kind="artist"
          :starred="a.starred"
          @update:starred="onStarChanged('artist', a, $event)"
          @error="onStarError"
        />
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <div v-if="starredOnly ? starredLoading : loading" class="empty-state" style="grid-column: 1/-1">{{ t("common.loading") }}</div>
      <div v-else-if="!displayArtists.length && !error" class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon"><Icon name="note" /></div>
        <div>{{ starredOnly ? t("library.noStarred") : t("library.noArtists") }}</div>
      </div>
    </div>

    <!-- Liked albums and songs stay as single-category tabs, matching Library. -->
    <div v-else-if="starredOnly && tab === 'albums'" class="album-grid">
      <div v-for="al in displayAlbums" :key="al.id" class="card hoverable album-card" @click="openAlbum(al)">
        <div class="album-cover">
          <BudgetedImage v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 256)" :alt="al.name" @error="al.coverArt = ''" />
          <span v-else class="album-cover-placeholder"><Icon name="note" /></span>
        </div>
        <div class="album-body">
          <div class="album-name">{{ al.name }}</div>
          <div class="mono-label">{{ al.artist || "—" }}<template v-if="al.songCount"> · {{ t("library.trackCount", { n: al.songCount }) }}</template></div>
        </div>
        <StarButton
          class="card-like-btn"
          :id="al.id"
          kind="album"
          :starred="al.starred"
          @update:starred="onStarChanged('album', al, $event)"
          @error="onStarError"
        />
        <button class="card-share-btn" :title="t('library.share')" @click.stop="openShare('album', al.id, al.name)"><Icon name="up" /></button>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <div v-if="starredLoading" class="empty-state" style="grid-column: 1/-1">{{ t("common.loading") }}</div>
      <div v-else-if="!displayAlbums.length" class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon"><Icon name="heart" /></div>
        <div>{{ t("library.noStarred") }}</div>
      </div>
    </div>

    <div v-else-if="starredOnly && tab === 'songs'">
      <div class="table-wrap song-table" style="--grid-cols: 36px 2fr 1.5fr 1fr 64px 32px 32px">
        <div class="table-header">
          <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colAlbum") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span></span><span></span>
        </div>
        <div
          v-for="(s, i) in displaySongs"
          :key="s.id"
          class="table-row song-row"
          :data-song-id="s.id"
          :class="{ playing: player.current?.id === s.id }"
          @click="playFromStarred(i)"
        >
          <span class="song-no"><Icon v-if="player.current?.id === s.id && player.playing" name="play" /><template v-else>{{ (listPage - 1) * pageSize + i + 1 }}</template></span>
          <span class="song-title">{{ s.title }}</span>
          <span class="song-album" :class="{ clickable: s.albumId }" @click.stop="s.albumId && openAlbumById(s.albumId, s.album)">{{ s.album }}</span>
          <span class="song-artist-group" :data-album="s.album">
            <template v-for="(artist, idx) in parseArtists(s.artist)" :key="idx">
              <span v-if="idx > 0" class="artist-sep">,</span>
              <span class="song-artist clickable" :class="{ 'has-id': s.artistId }" @click.stop="s.artistId ? openArtistById(s.artistId, artist) : searchAndOpenArtist(artist)">{{ artist }}</span>
            </template>
          </span>
          <span class="song-time">{{ formatDuration(s.duration) }}</span>
          <StarButton
            class="row-like-btn"
            :id="s.id"
            kind="song"
            :starred="!!s.starred"
            @update:starred="onStarChanged('song', s, $event)"
            @error="onStarError"
          />
          <SongRowMenu
           :song-id="s.id"
           :title="s.title"
           :starred="!!s.starred"
           :is-admin="isAdmin"
           :can-manage-files="canManageFiles"
            :open="openMenuId === s.id"
            @toggle="toggleRowMenu(s.id)"
            @close="closeRowMenu"
            @edit="openEditor(s)"
           @share="openShare('song', s.id, s.title)"
           @view-file="openSongInFiles(s)"
           @add-playlist="openAddToPlaylist(s.id, s.title)"
           @play-next="queueNext(s)"
           @update:starred="onStarChanged('song', s, $event)"
           @error="onStarError"
         />
        </div>
        <div v-if="starredLoading" class="empty-state">{{ t("common.loading") }}</div>
        <div v-else-if="!displaySongs.length" class="empty-state">
          <div class="empty-state-icon"><Icon name="heart" /></div>
          <div>{{ t("library.noStarred") }}</div>
        </div>
      </div>
    </div>

    <!-- Tab: all albums -->
    <!-- waterfall grid — allAlbums is pre-split into fixed column
         buckets (round-robin by index, see albumWaterfallCols) so on-screen
         order always matches fetch/alphabetical order and a late-loading
         cover only grows its own column, never reflows the whole grid. -->
    <div v-else-if="!starredOnly && tab === 'albums'">
      <div class="album-grid album-waterfall" ref="albumWaterfallEl">
        <div v-for="(col, ci) in albumWaterfallCols" :key="ci" class="waterfall-col">
          <div
            v-for="item in col"
            :key="item.key"
            class="card hoverable album-card"
            @click="item.kind === 'group' ? openDisplayGroup(item.group) : openAlbum(item.album)"
          >
            <div class="album-cover">
              <BudgetedImage v-if="item.kind === 'album' ? item.album.coverArt : item.representative.coverArt" :src="coverArtUrl(item.kind === 'album' ? item.album.coverArt : item.representative.coverArt, 256)" :alt="item.kind === 'album' ? item.album.name : item.group.name" @error="item.kind === 'album' ? item.album.coverArt = '' : item.representative.coverArt = ''" />
              <span v-else class="album-cover-placeholder"><Icon name="note" /></span>
            </div>
            <div class="album-body">
              <div class="album-name">{{ item.kind === 'album' ? item.album.name : item.group.name }}</div>
              <div class="mono-label" v-if="item.kind === 'album'">{{ item.album.artist || "—" }}<template v-if="item.album.songCount"> · {{ t("library.trackCount", { n: item.album.songCount }) }}</template></div>
              <div class="mono-label" v-else>{{ t("library.albumEditionCount", { n: item.group.memberCount }) }}</div>
            </div>
            <!-- Per-album share. -->
            <StarButton
              v-if="item.kind === 'album'"
              class="card-like-btn"
              :id="item.album.id"
              kind="album"
              :starred="item.album.starred"
              @update:starred="onStarChanged('album', item.album, $event)"
              @error="onStarError"
            />
            <button v-if="item.kind === 'album'" class="card-share-btn" :title="t('library.share')" @click.stop="openShare('album', item.album.id, item.album.name)"><Icon name="up" /></button>
            <div class="corner corner-tr"></div>
            <div class="corner corner-bl"></div>
          </div>
        </div>
      </div>
      <div v-if="!allAlbums.length && !loading" class="empty-state">
        <div class="empty-state-icon"><Icon name="empty" /></div>
        <div>{{ t("library.noAlbums") }}</div>
      </div>
      <div v-if="loading" class="load-more mono-label">{{ t("common.loading") }}</div>
    </div>

    <!-- Tab: all songs -->
    <div v-else-if="!starredOnly && tab === 'songs'">
      <!-- edit mode toggle. Admins default to browse mode; click to reveal
           checkboxes / batch toolbar. The button lives at the top-right of the
           songs tab so it's discoverable without cluttering the song list. -->
      <div v-if="isAdmin" class="songs-tab-toolbar">
        <button
          :class="['btn-secondary', 'btn-sm', 'edit-mode-toggle', { 'edit-mode-active': editMode }]"
          @click="toggleEditMode"
        >{{ editMode ? t("library.editModeOff") : t("library.editModeOn") }}</button>
      </div>
      <!-- Discoverability hint — explains the per-row edit action and the batch
           workflow so admins don't have to hover-discover them. Fades to 50%
           opacity after 5s (see songsHintFaded) but stays visible. -->
      <div
        v-if="isAdmin && editMode && allSongs.length > 0"
        class="songs-hint"
        :class="{ faded: songsHintFaded }"
      >{{ t("library.songsHint") }}</div>
      <!-- Batch-edit preview row. Shown only when nothing is selected;
           swaps out for the active batch-toolbar below as soon as the user
           ticks a row. -->
      <div v-if="isAdmin && editMode && !selectedIds.length" class="batch-preview">
        <span class="mono-label">{{ t("library.batchHint") }}</span>
      </div>
      <!-- Batch selection toolbar (admin-only) -->
      <div v-if="isAdmin && editMode && selectedIds.length" class="batch-toolbar">
        <span class="mono-label">{{ t("library.selected", { n: selectedIds.length }) }}</span>
        <button class="btn-secondary btn-sm" @click="clearSelection">{{ t("library.clearSelection") }}</button>
        <button
          class="btn-primary btn-sm"
          :disabled="selectedIds.length > BATCH_MAX"
          :title="selectedIds.length > BATCH_MAX ? t('library.batchTooMany') : ''"
          @click="openBatchEditor"
        >{{ t("library.batchEdit") }}</button>
        <button
          class="btn-secondary btn-sm"
          :disabled="rescanBusy || selectedIds.length > BATCH_MAX"
          :title="selectedIds.length > BATCH_MAX ? t('library.batchTooMany') : ''"
          @click="batchRescan"
        >{{ rescanBusy ? t("library.rescanning") : t("library.rescan") }}</button>
        <button
          class="btn-secondary btn-sm"
          :disabled="selectedIds.length > BATCH_MAX"
          :title="selectedIds.length > BATCH_MAX ? t('library.batchTooMany') : ''"
          @click="openBatchShare"
        >{{ t("library.batchShare") }}</button>
        <span v-if="rescanMsg" class="mono-label">{{ rescanMsg }}</span>
      </div>
      <!-- no `auto` tracks (per-row grids misalign); artist/time get
           fixed-share tracks so columns line up across every row. -->
      <div class="table-wrap song-table" :style="`--grid-cols: ${isAdmin && editMode ? '24px ' : ''}36px 2fr 1.5fr 1fr 64px 32px 32px`">
        <div class="table-header">
          <span v-if="isAdmin && editMode"></span>
          <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colAlbum") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span></span><span></span>
        </div>
        <div
           v-for="(s, i) in displaySongs"
          :key="s.id"
          class="table-row song-row"
          :data-song-id="s.id"
          :class="{ playing: player.current?.id === s.id, selected: selectedSet.has(s.id) }"
          @click="playFromAll(i)"
        >
         <input
            v-if="isAdmin && editMode"
            type="checkbox"
            class="row-check"
            :checked="selectedSet.has(s.id)"
            :title="t('library.select')"
            @click.stop="toggleSelected(s.id)"
          />
          <span class="song-no"><Icon v-if="player.current?.id === s.id && player.playing" name="play" /><template v-else>{{ (listPage - 1) * pageSize + i + 1 }}</template></span>
          <span class="song-title">{{ s.title }}</span>
          <span class="song-album" :class="{ clickable: s.albumId }" @click.stop="s.albumId && openAlbumById(s.albumId, s.album)">{{ s.album }}</span>
            <span class="song-artist-group" :data-album="s.album">
              <template v-for="(artist, idx) in parseArtists(s.artist)" :key="idx">
                <span v-if="idx > 0" class="artist-sep">,</span>
                <span class="song-artist clickable" :class="{ 'has-id': s.artistId }" @click.stop="s.artistId ? openArtistById(s.artistId, artist) : searchAndOpenArtist(artist)">{{ artist }}</span>
              </template>
            </span>
           <span class="song-time">{{ formatDuration(s.duration) }}</span>
           <StarButton
             class="row-like-btn"
             :id="s.id"
             kind="song"
             :starred="!!s.starred"
             @update:starred="onStarChanged('song', s, $event)"
             @error="onStarError"
           />
           <SongRowMenu
            :song-id="s.id"
            :title="s.title"
             :starred="!!s.starred"
            :is-admin="isAdmin"
            :can-manage-files="canManageFiles"
            :open="openMenuId === s.id"
            @toggle="toggleRowMenu(s.id)"
            @close="closeRowMenu"
            @edit="openEditor(s)"
            @share="openShare('song', s.id, s.title)"
            @view-file="openSongInFiles(s)"
            @add-playlist="openAddToPlaylist(s.id, s.title)"
           @play-next="queueNext(s)"
            @update:starred="onStarChanged('song', s, $event)"
            @error="onStarError"
          />
        </div>
         <div v-if="!displaySongs.length && !loading" class="empty-state">{{ t("library.noTracks") }}</div>
      </div>
      <div v-if="loading" class="load-more mono-label">{{ t("common.loading") }}</div>
    </div>
    <div v-if="!currentArtist && !currentAlbum && !currentDisplayGroup && !embedded" class="library-pagination">
      <span class="mono-label">{{ t("library.pageNumber", { page: listPage }) }}</span>
      <button class="btn-secondary btn-sm" :disabled="loading || listPage <= 1" @click="setListPage(listPage - 1)">{{ t("library.previousPage") }}</button>
      <button class="btn-secondary btn-sm" :disabled="loading || !listHasNext" @click="setListPage(listPage + 1)">{{ t("library.nextPage") }}</button>
    </div>
    </template>

    <!-- Library-wide search results: replaces tabs/drilldown while a query is active. -->
    <div v-else class="search-results" aria-live="polite">
      <label class="page-size-control search-page-size-control">
        <span class="mono-label">{{ t("library.pageSize") }}</span>
        <FluentSelect :model-value="String(pageSize)" class="form-input page-size-select" :aria-label="t('library.pageSize')" :options="pageSizeOptions" @update:model-value="pageSize = Number($event) as LibraryPageSize" />
      </label>
      <div v-if="searching" class="empty-state">{{ t("common.loading") }}</div>
      <div v-else-if="searchError" class="empty-state search-error">
        <div>{{ searchError }}</div>
        <button type="button" class="btn-secondary btn-sm" @click="retrySearch">{{ t("common.retry") }}</button>
      </div>
      <div
        v-else-if="searchResults && !searchResults.artists.length && !searchResults.albums.length && !searchResults.songs.length"
        class="empty-state"
      >{{ t("library.searchNoResults") }}</div>
      <template v-else-if="searchResults">
        <div v-if="searchResults.artists.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabArtists") }}</div>
          <div class="artist-grid">
            <div
              v-for="a in searchResults.artists"
              :key="a.id"
              class="card hoverable artist-card"
              @click="openArtist(a)"
            >
              <div class="artist-glyph">{{ a.name.charAt(0).toUpperCase() || "?" }}</div>
              <div class="artist-name">{{ a.name }}</div>
              <div class="mono-label" v-if="a.albumCount">{{ t("library.albumCount", { n: a.albumCount }) }}</div>
              <StarButton
                class="card-like-btn artist-like-btn"
                :id="a.id"
                kind="artist"
                :starred="a.starred"
                @update:starred="onStarChanged('artist', a, $event)"
                @error="onStarError"
              />
              <div class="corner corner-tr"></div>
              <div class="corner corner-bl"></div>
            </div>
          </div>
          <div class="library-pagination">
            <span class="mono-label">{{ t("library.pageNumber", { page: searchPages.artists }) }}</span>
            <button class="btn-secondary btn-sm" :disabled="searching || searchPages.artists <= 1" @click="setSearchPage('artists', searchPages.artists - 1)">{{ t("library.previousPage") }}</button>
            <button class="btn-secondary btn-sm" :disabled="searching || !searchHasMore.artists" @click="setSearchPage('artists', searchPages.artists + 1)">{{ t("library.nextPage") }}</button>
          </div>
        </div>

        <div v-if="searchAlbumDisplayCards.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabAlbums") }}</div>
          <div class="album-grid">
            <div
              v-for="item in pagedSearchAlbumDisplayCards"
              :key="item.key"
              class="card hoverable album-card"
              @click="item.kind === 'group' ? openDisplayGroup(item.group) : openAlbum(item.album)"
            >
              <div class="album-cover">
                <BudgetedImage v-if="item.kind === 'album' ? item.album.coverArt : item.representative.coverArt" :src="coverArtUrl(item.kind === 'album' ? item.album.coverArt : item.representative.coverArt, 256)" :alt="item.kind === 'album' ? item.album.name : item.group.name" @error="item.kind === 'album' ? item.album.coverArt = '' : item.representative.coverArt = ''" />
                <span v-else class="album-cover-placeholder"><Icon name="note" /></span>
              </div>
              <div class="album-body">
                <div class="album-name">{{ item.kind === 'album' ? item.album.name : item.group.name }}</div>
                <div class="mono-label" v-if="item.kind === 'album'">{{ item.album.artist || "—" }}<template v-if="item.album.songCount"> · {{ t("library.trackCount", { n: item.album.songCount }) }}</template></div>
                <div class="mono-label" v-else>{{ t("library.albumEditionCount", { n: item.group.memberCount }) }}</div>
              </div>
              <StarButton
                v-if="item.kind === 'album'"
                class="card-like-btn"
                :id="item.album.id"
                kind="album"
                :starred="item.album.starred"
                @update:starred="onStarChanged('album', item.album, $event)"
                @error="onStarError"
              />
              <button v-if="item.kind === 'album'" class="card-share-btn" :title="t('library.share')" @click.stop="openShare('album', item.album.id, item.album.name)"><Icon name="up" /></button>
              <div class="corner corner-tr"></div>
              <div class="corner corner-bl"></div>
            </div>
          </div>
          <div class="library-pagination">
            <span class="mono-label">{{ t("library.pageNumber", { page: searchPages.albums }) }}</span>
            <button class="btn-secondary btn-sm" :disabled="searching || searchPages.albums <= 1" @click="setSearchPage('albums', searchPages.albums - 1)">{{ t("library.previousPage") }}</button>
            <button class="btn-secondary btn-sm" :disabled="searching || !searchHasMore.albums" @click="setSearchPage('albums', searchPages.albums + 1)">{{ t("library.nextPage") }}</button>
          </div>
        </div>

        <div v-if="searchResults.songs.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabSongs") }}</div>
          <div class="table-wrap song-table" style="--grid-cols: 36px 2fr 1.5fr 1fr 64px 32px 32px">
            <div class="table-header">
              <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colAlbum") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span></span><span></span>
            </div>
            <div
              v-for="(s, i) in pagedSearchSongs"
              :key="s.id"
              class="table-row song-row"
              :class="{ playing: player.current?.id === s.id }"
              @click="playFromSearch(i)"
            >
              <span class="song-no"><Icon v-if="player.current?.id === s.id && player.playing" name="play" /><template v-else>{{ (searchPages.songs - 1) * pageSize + i + 1 }}</template></span>
              <span class="song-title">{{ s.title }}</span>
              <span class="song-album" :class="{ clickable: s.albumId }" @click.stop="s.albumId && openAlbumById(s.albumId, s.album)">{{ s.album }}</span>
               <span class="song-artist-group" :data-album="s.album">
                <template v-for="(artist, idx) in parseArtists(s.artist)" :key="idx">
                  <span v-if="idx > 0" class="artist-sep">,</span>
                  <span class="song-artist clickable" :class="{ 'has-id': s.artistId }" @click.stop="s.artistId ? openArtistById(s.artistId, artist) : searchAndOpenArtist(artist)">{{ artist }}</span>
                </template>
              </span>
              <span class="song-time">{{ formatDuration(s.duration) }}</span>
              <StarButton
                class="row-like-btn"
                :id="s.id"
                kind="song"
                :starred="!!s.starred"
                @update:starred="onStarChanged('song', s, $event)"
                @error="onStarError"
              />
              <SongRowMenu
                :song-id="s.id"
                :title="s.title"
                :starred="!!s.starred"
                :is-admin="isAdmin"
                :can-manage-files="canManageFiles"
                :open="openMenuId === s.id"
                @toggle="toggleRowMenu(s.id)"
                @close="closeRowMenu"
                @edit="openEditor(s)"
            @share="openShare('song', s.id, s.title)"
            @view-file="openSongInFiles(s)"
            @add-playlist="openAddToPlaylist(s.id, s.title)"
           @play-next="queueNext(s)"
             @update:starred="onStarChanged('song', s, $event)"
             @error="onStarError"
          />
            </div>
          </div>
          <div class="library-pagination">
            <span class="mono-label">{{ t("library.pageNumber", { page: searchPages.songs }) }}</span>
            <button class="btn-secondary btn-sm" :disabled="searching || searchPages.songs <= 1" @click="setSearchPage('songs', searchPages.songs - 1)">{{ t("library.previousPage") }}</button>
            <button class="btn-secondary btn-sm" :disabled="searching || !searchHasMore.songs" @click="setSearchPage('songs', searchPages.songs + 1)">{{ t("library.nextPage") }}</button>
          </div>
        </div>
      </template>
    </div>

    <!-- Tag editor (single + batch) -->
    <Teleport to="body">
    <TagEditor
      :open="editorOpen"
      :mode="editorMode"
      :song-ids="editTargets.map((t) => t.id)"
      :initial-tags="editInitial"
      :existing-cover-url="editExistingCoverUrl"
      :busy="editBusy"
      :message="editMsg"
      :error="editErr"
      @submit="onEditorSubmit"
      @close="closeEditor"
    >
     <!-- Scrape button in extras slot. Single-mode only; batch UX has no
           obvious "one master query" so we hide the button there. -->
      <template v-if="editorMode === 'single'" #extras="{ form, apply, applyCoverUrl }">
        <ScrapeButton
          :initial-query="scrapeQueryFromForm(form)"
          :song-master-id="editTargets[0]?.id || ''"
          :current-title="form.title"
          :current-artist="form.artist"
          :current-album="form.album"
          @apply="(r: ScrapeResult) => applyScrapeResult(form, apply, r, applyCoverUrl)"
        />
      </template>
    </TagEditor>
    </Teleport>

    <ShareDialog
      :open="shareOpen"
      :song-ids="shareSongIds"
      :label="shareLabel"
      @close="closeShare"
      @created="onShareCreated"
    />

    <Teleport to="body">
    <!-- Add-to-playlist modal. Singleton at root, mirrors the shared modal
         pattern — opens on the per-song [＋] button. Lists existing playlists
         and exposes a "create new" sentinel that round-trips through
         createPlaylist with the seed song. -->
    <div v-if="addPlaylistOpen" class="modal-backdrop" @click.self="closeAddToPlaylist">
      <div class="modal add-playlist-modal">
        <div class="modal-title">{{ t("library.addToPlaylist") }} — {{ addPlaylistTarget?.title }}</div>

        <div v-if="addPlaylistLoading" class="empty-state" style="padding: 1rem">
          {{ t("common.loading") }}
        </div>

        <div v-else-if="addPlaylistCreating" class="form-group" style="margin-top: 0.6rem">
          <label class="form-label">{{ t("playlists.name") }}</label>
          <input v-model="addPlaylistNewName" class="form-input" autofocus :placeholder="t('playlists.namePlaceholder')" />
        </div>

        <template v-else>
          <div v-if="!addPlaylistList.length" class="empty-state" style="padding: 1rem">
            {{ t("library.noPlaylists") }}
          </div>
          <div v-else class="add-playlist-list">
            <div
              v-for="p in addPlaylistList"
              :key="p.id"
              class="add-playlist-row"
              @click="addSongToPlaylist(p.id)"
            >
             <span class="add-playlist-name">{{ p.name }}</span>
              <span class="mono-label">{{ p.songCount }} <Icon name="note" /></span>
            </div>
          </div>
          <button class="create-new-row" @click="beginCreateNew">{{ t("library.createNewPlaylist") }}</button>
        </template>

        <div v-if="addPlaylistMessage" class="status-badge info" style="margin-top: 0.6rem">{{ addPlaylistMessage }}</div>
        <div v-if="addPlaylistError" class="status-badge error" style="margin-top: 0.6rem">{{ addPlaylistError }}</div>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeAddToPlaylist">{{ t("playlists.cancel") }}</button>
          <button
            v-if="addPlaylistCreating"
            class="btn-primary"
            :disabled="addPlaylistBusy"
            @click="submitCreateAndAdd"
          >{{ addPlaylistBusy ? t("common.loading") : t("playlists.save") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.library--embedded { padding: 24px; }
.media-detail-heading { flex-wrap: wrap; align-items: center; gap: 16px; }
.media-detail-heading .media-detail-titles { flex: 1; min-width: 0; }
.media-detail-cover { width: 96px; height: 96px; object-fit: cover; flex-shrink: 0; border-radius: 8px; }
.media-detail-heading .detail-actions { width: 100%; flex-wrap: wrap; }
.media-detail-heading .page-title { overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .library--embedded { padding: 16px; }
  .media-detail-cover { width: 72px; height: 72px; }
  .media-detail-heading .page-title { font-size: 24px; }
}

.breadcrumb { margin-bottom: 0.25rem; }
.breadcrumb a { color: var(--color-text-muted); cursor: pointer; }
.breadcrumb a:hover { color: var(--color-accent-primary); }
.breadcrumb span { color: var(--color-accent-primary); }
.detail-actions { display: flex; align-items: center; gap: 0.65rem; }

/* view tabs */
.view-tabs {
  display: flex; gap: 0;
  border-bottom: 1px solid var(--color-border-subtle);
}
.library-controls {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.25rem;
}
.sort-control, .page-size-control {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}
.sort-select { min-width: 150px; padding-top: 0.45rem; padding-bottom: 0.45rem; }
.page-size-select { min-width: 76px; padding-top: 0.45rem; padding-bottom: 0.45rem; }
.search-page-size-control { justify-content: flex-end; margin-bottom: 1rem; }
.library-pagination { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 0.55rem; padding: 1rem 0; }
.locate-current-btn { margin-left: auto; }
.view-tab {
  padding: 0.55rem 1.3rem;
  background: none; border: none; cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: all 0.15s;
}
.view-tab:hover { color: var(--color-text-primary); }
.view-tab.active { color: var(--color-accent-primary); border-bottom-color: var(--color-accent-primary); }

/* library-wide search */
.library-search {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  max-width: 560px;
}
.primary-search-field { position: relative; flex: 1 1 260px; min-width: 0; }
.primary-search-field .search-input { width: 100%; }
.extended-search-toggle { flex: 0 0 auto; }
.extended-search-panel { position: relative; flex: 1 1 100%; min-width: 0; }
.extended-search-panel .search-input { width: 100%; padding-right: 2rem; }
.search-input { padding-right: 2rem; }
.search-input::-webkit-search-cancel-button { display: none; }
.search-clear {
  position: absolute;
  right: 0.5rem;
  background: none; border: none; cursor: pointer;
  color: var(--color-text-muted);
  font-size: var(--fs-sm);
  padding: 0.2rem;
}
.search-clear:hover { color: var(--color-accent-primary); }

.search-section { margin-bottom: 1.75rem; }
.search-section-title {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: 0.6rem;
}

.load-more { display: flex; justify-content: center; padding: 1.25rem 0 0.5rem; }
/* invisible IntersectionObserver sentinel: must occupy vertical space
   inside the scroll flow so the observer can see it approach the viewport.
   1px tall is enough; a tiny margin keeps it clear of grid/table borders. */
.scroll-sentinel { width: 1px; height: 1px; margin: 0; padding: 0; }

/* artists */
.artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 1rem; align-items: start; }
.artist-card { position: relative; text-align: center; padding: 1.5rem 1rem 1.1rem; }
.artist-glyph {
  width: 56px; height: 56px; margin: 0 auto 0.7rem;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display);
  font-size: 1.6rem;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
}
.artist-name {
  font-weight: 700; font-size: var(--fs-md); color: var(--color-text-primary);
  margin-bottom: 0.2rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.artist-detail { display: flex; flex-direction: column; gap: 1rem; }
.artist-info {
  display: flex; gap: 1rem; align-items: flex-start;
  padding: 1rem;
}
.artist-info-image {
  width: 120px; height: 120px; flex: 0 0 120px;
  object-fit: cover; border: 1px solid var(--color-border-subtle);
}
.artist-info-body { min-width: 0; }
.artist-biography {
  margin: 0 0 0.7rem; color: var(--color-text-secondary);
  line-height: 1.6; white-space: pre-wrap;
}
.artist-info-link { color: var(--color-accent-primary); font-family: var(--font-mono); font-size: var(--fs-sm); }
.artist-info-error { color: var(--color-text-muted); }

/* albums */
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 1rem; align-items: start; }
.album-card { padding: 0; overflow: hidden; }
.album-cover {
  aspect-ratio: 1;
  background: var(--color-bg-primary);
  display: flex; align-items: center; justify-content: center;
  border-bottom: 1px solid var(--color-border-subtle);
  overflow: hidden;
}
.album-cover img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.4s ease; }
.album-card:hover .album-cover img { transform: scale(1.05); }
.album-cover-placeholder { font-size: 2rem; color: var(--color-text-muted); }

/* Waterfall grid for the full-library albums tab. allAlbums is
   pre-split into fixed column buckets in script (round-robin by index, see
   albumWaterfallCols) and each bucket renders as its own independent
   vertical flex stack — that's what makes it a waterfall rather than a
   uniform grid: a column with a two-line album name just runs longer, it
   doesn't force every other column's row band to match its height the way
   CSS Grid auto-rows would.
   Covers stay at the fixed 1:1 aspect ratio from the base .album-cover rule
   (deliberately NOT switched to natural image aspect ratio) — that was
   tried and reverted: it made each cover's box grow/jump the moment its
   image finished decoding, and because that happens near-simultaneously
   for a whole viewport of covers on load, it read as repeated flicker.
   Column buckets being fixed by index (not by running content height, like
   CSS multi-column `columns:` used before) also means a cover loading late
   only pushes down its own column — never reshuffles items into a
   different column. */
.album-waterfall {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}
.waterfall-col {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1 1 0;
  min-width: 0;
}
.album-body { padding: 0.8rem 0.9rem 0.9rem; }
.album-name {
  font-weight: 700; font-size: var(--fs-md); color: var(--color-text-primary);
  margin-bottom: 0.15rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* songs */
.song-row { cursor: pointer; }
.song-row.playing { background: var(--color-accent-dim); }
.song-row-located { animation: current-song-locate 1.6s ease-out; }
@keyframes current-song-locate { 0%, 35% { box-shadow: inset 3px 0 var(--color-accent-primary), inset 0 0 0 999px color-mix(in srgb, var(--color-accent-primary) 20%, transparent); } 100% { box-shadow: none; } }
.song-no { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); text-align: right; }
.song-title { font-size: var(--fs-md); color: var(--color-text-primary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-album { font-size: var(--fs-sm); color: var(--color-text-secondary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-album.clickable { color: var(--color-accent-primary); cursor: pointer; }
.song-album.clickable:hover { text-decoration: underline; }
.song-artist-group { display: flex; flex-wrap: wrap; gap: 0.2rem; min-width: 0; }
.artist-sep { margin: 0 -0.2rem; }
.song-artist { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-secondary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-artist.clickable { color: var(--color-accent-primary); cursor: pointer; }
.song-artist.clickable:hover { text-decoration: underline; }
.song-time { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); }

/* Songs-tab discoverability hint. Sits above the song table on admins
   only; auto-fades to 50% opacity after 5s (see songsHintFaded). */
.songs-hint {
  color: var(--color-text-muted);
  font-size: 0.85rem;
  padding: 0.5rem 1rem;
  margin-bottom: 0.5rem;
  border-left: 2px solid var(--color-accent-dim);
  background: var(--color-bg-tertiary);
  opacity: 1;
  transition: opacity 0.4s ease;
}
.songs-hint.faded { opacity: 0.5; }

/* Songs-tab edit mode toggle. Aligns to the right so it doesn't steal
   attention from the song list; turns accent-colored when edit mode is on. */
.songs-tab-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.5rem;
}
.edit-mode-toggle { font-family: var(--font-mono); font-size: var(--fs-sm); }
.edit-mode-active {
  border-color: var(--color-accent-primary, #6366f1);
  color: var(--color-accent-primary, #6366f1);
}

/* batch-edit preview row. Displaces itself in favour of batch-toolbar
   the moment a row is ticked, so the two never stack. */
.batch-preview {
  display: flex; align-items: center;
  padding: 0.45rem 0.75rem;
  margin-bottom: 0.75rem;
  border: 1px dashed var(--color-border-subtle);
  color: var(--color-text-muted);
  background: var(--color-bg-secondary);
}

/* batch selection (songs tab) */
.batch-toolbar {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  border: 1px solid var(--color-accent-dim);
  border-left: 2px solid var(--color-accent-primary);
  background: var(--color-bg-tertiary);
}
.row-check {
  width: 14px; height: 14px;
  accent-color: var(--color-accent-primary);
  cursor: pointer;
}
.song-row.selected { background: var(--color-accent-dim); }
.song-row.selected:hover { background: var(--color-accent-dim); }

/* === Share affordances ===
   card-share-btn (per-album): top-right of the cover area.
   album-share-btn: standalone button above the song table in album drilldown.
   Per-song share now lives inside the SongRowMenu "⋮" dropdown (see that
   component) rather than as its own row button. */
.song-row { position: relative; }

.album-card { position: relative; }
.group-edition-card { display: block; width: 100%; text-align: left; }
.card-like-btn {
  position: absolute;
  top: 0.45rem;
  left: 0.5rem;
  z-index: 2;
}
.artist-like-btn { left: auto; right: 0.5rem; }
.card-share-btn {
  position: absolute;
  top: 0.45rem;
  right: 0.5rem;
  z-index: 2;
  background: rgba(10, 10, 11, 0.7);
  border: 1px solid var(--color-border-subtle);
  color: var(--color-accent-primary);
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--fs-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  border-radius: 2px;
}
.album-card:hover .card-share-btn { opacity: 1; }
.card-share-btn:hover { background: var(--color-bg-tertiary); }

.album-share-btn {
  display: block;
  width: 100%;
  text-align: right;
  padding: 0.45rem 1rem;
  background: var(--color-bg-primary);
  border: none;
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-accent-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: background 0.15s;
}
.album-share-btn:hover { background: var(--color-bg-tertiary); }

.add-playlist-modal { max-width: 480px; }
.add-playlist-list {
  max-height: 320px; overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-secondary);
}
.add-playlist-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.7rem;
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
  transition: background 0.12s;
}
.add-playlist-row:last-child { border-bottom: none; }
.add-playlist-row:hover { background: var(--color-bg-tertiary); }
.add-playlist-name {
  color: var(--color-text-primary); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.create-new-row {
  display: block; width: 100%;
  margin-top: 0.5rem;
  padding: 0.5rem 0.7rem;
  background: none;
  border: 1px dashed var(--color-border-subtle);
  color: var(--color-accent-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.create-new-row:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent-primary);
}

@media (max-width: 560px) {
  .library-controls { align-items: stretch; flex-direction: column; gap: 0.7rem; }
  .sort-control { justify-content: space-between; }
  .sort-select { flex: 1; }
  .view-tab { padding-left: 0.7rem; padding-right: 0.7rem; font-size: var(--fs-xs); }
  .artist-info { flex-direction: column; }
  .artist-info-image { width: 88px; height: 88px; flex-basis: 88px; }
}

@media (max-width: 768px) {
  .album-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; }
  .album-waterfall { gap: 0.7rem; }
  .waterfall-col { gap: 0.7rem; }

  .song-table .table-header { display: none; }
  .song-table .song-row {
    grid-template-columns: minmax(0, 1fr) auto 30px;
    grid-template-areas:
      "title time menu"
      "artist artist menu";
    gap: 0.15rem 0.6rem;
    padding: 0.55rem 0.7rem;
    align-items: center;
  }
  .song-table .song-no,
  .song-table .song-album,
  .song-table .row-like-btn { display: none; }
  .song-table .song-title {
    grid-area: title;
    font-size: var(--fs-lg);
    font-weight: 700;
  }
  .song-table .song-time { grid-area: time; align-self: start; }
  /* The artist chips live in a wrapper, so the wrapper is the grid item and
     the one place the album suffix can hang off exactly once. */
  .song-table .song-artist-group {
    grid-area: artist;
    max-width: 100%;
  }
  .song-table .song-artist { font-size: var(--fs-xs); }
  .song-table .song-artist-group::after {
    content: " - " attr(data-album);
    color: var(--color-text-muted);
    font-size: var(--fs-xs);
  }
  .song-table :deep(.row-menu-wrap) { grid-area: menu; align-self: center; }
  .song-table :deep(.row-menu-btn) { opacity: 1; }
  .song-table .row-check {
    position: absolute;
    top: 0.7rem;
    left: 0.45rem;
    z-index: 1;
  }
  .song-table .song-row:has(.row-check) .song-title { padding-left: 1.25rem; }
}

@media (min-width: 561px) and (max-width: 768px) {
  .album-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
</style>
