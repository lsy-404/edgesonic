
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import Icon from "./Icon.vue";
import {
  searchAll,
  resolveResult,
  submitResult,
  makeProxyFetch,
  type ScrapeResult,
  type ScrapeSource,
} from "../lib/scrape";

const { t } = useI18n();
const { edgesonicFetch, tagPost } = useAuth();

const props = withDefaults(
  defineProps<{
    /** Pre-filled query string. The component shows it in an editable input. */
    initialQuery?: string;
    /** Song master id — if present, submitResult will tag the audit row. */
    songMasterId?: string;
    currentTitle?: string;
    currentArtist?: string;
    currentAlbum?: string;
    /** Compact mode hides the help text (good for narrow modals). */
    compact?: boolean;
  }>(),
  { initialQuery: "", songMasterId: "", currentTitle: "", currentArtist: "", currentAlbum: "", compact: false }
);

const emit = defineEmits<{
  (e: "apply", result: ScrapeResult): void;
}>();

const enabledSources = ref<ScrapeSource[]>([]);
const scrapeEnabled = ref<boolean>(true);
const configReady = ref(false);

async function loadConfig() {
  try {
    const data = JSON.parse(await edgesonicFetch("features/list"));
    if (!data.ok) throw new Error(data.error || "getFeatures failed");
    const flag = (data.features || []).find((f: { key: string }) => f.key === "scrape_enabled");
    scrapeEnabled.value = flag ? Number(flag.value) !== 0 : true;
    const list = (data.featureStrings || []).find((f: { key: string }) => f.key === "scrape_enabled_sources");
    if (list?.value) {
      try {
        const parsed = JSON.parse(list.value);
        if (Array.isArray(parsed)) enabledSources.value = parsed as ScrapeSource[];
      } catch { enabledSources.value = ["lrc", "netease", "qmusic", "kugou"]; }
    } else {
      enabledSources.value = ["lrc", "netease", "qmusic", "kugou"];
    }
  } catch {
    // Settings unreachable (perm denied for non-admin?) — fall back to defaults
    // so end users can still scrape; the proxy itself is session-only either way.
    enabledSources.value = ["lrc", "netease", "qmusic", "kugou"];
    scrapeEnabled.value = true;
  }
  configReady.value = true;
}

const query = ref(props.initialQuery);
const open = ref(false);
const busy = ref(false);
const results = ref<ScrapeResult[]>([]);
const errors = ref<Array<{ source: ScrapeSource; error: string }>>([]);
const error = ref("");
const detail = ref<ScrapeResult | null>(null);
const selected = ref<Record<string, boolean>>({ title: true, artist: true, albumArtist: true, album: true, year: true, lyrics: true, cover: true });
const fieldKeys = ["title", "artist", "albumArtist", "album", "year", "lyrics", "cover"] as const;

watch(() => props.initialQuery, (v) => { query.value = v; });

const hasResults = computed(() => results.value.length > 0);
const sourceLabel: Record<ScrapeSource, string> = {
  lrc: "LRC Albums",
  netease: "NetEase",
  qmusic: "QQ Music",
  kugou: "Kugou",
  kuwo: "Kuwo",
  migu: "Migu",
};

async function runSearch() {
  if (!configReady.value) await loadConfig();
  if (!scrapeEnabled.value) {
    error.value = t("scrape.disabled");
    return;
  }
  const q = query.value.trim();
  if (!q) {
    error.value = t("scrape.emptyQuery");
    return;
  }
  busy.value = true;
  error.value = "";
  results.value = [];
  errors.value = [];
  try {
    const proxy = makeProxyFetch(tagPost);
    const resp = await searchAll({
      query: q,
      sources: enabledSources.value,
      proxyFetch: proxy,
      current: { title: props.currentTitle, artist: props.currentArtist, album: props.currentAlbum },
    });
    results.value = resp.results;
    errors.value = resp.errors;
    if (!resp.results.length) {
      error.value = resp.errors.length
        ? t("scrape.allSourcesFailed")
        : t("scrape.noResults");
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  busy.value = false;
}

function openPanel() {
  open.value = true;
  if (configReady.value === false) loadConfig();
  // Auto-run search if the parent supplied a meaningful initial query and we
  // haven't searched yet — saves a click in the common case.
  if (!hasResults.value && query.value.trim().length >= 2) {
    runSearch();
  }
}

function closePanel() {
  open.value = false;
  detail.value = null;
}

function onWindowKeydown(event: KeyboardEvent) { if (event.key === "Escape" && open.value) closePanel(); }
window.addEventListener("keydown", onWindowKeydown);
onBeforeUnmount(() => window.removeEventListener("keydown", onWindowKeydown));

async function showDetail(r: ScrapeResult) {
  busy.value = true; error.value = "";
  selected.value = { title: true, artist: true, albumArtist: true, album: true, year: true, lyrics: true, cover: true };
  try { detail.value = await resolveResult(r, makeProxyFetch(tagPost)); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  busy.value = false;
}

function fieldValue(result: ScrapeResult, field: typeof fieldKeys[number]): string {
  if (field === "cover") return result.coverUrl || "—";
  const value = result[field];
  return value == null || value === "" ? "—" : String(value);
}

async function applyResult(r: ScrapeResult) {
  busy.value = true;
  let resolved: ScrapeResult = r;
  try {
    // Detail results are already resolved; only a compact search row needs
    // the additional detail request.
    if (r !== detail.value) resolved = await resolveResult(r, makeProxyFetch(tagPost));
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    busy.value = false;
    return;
  }
  const partial: ScrapeResult = {
    ...resolved,
    title: selected.value.title ? resolved.title : "",
    artist: selected.value.artist ? resolved.artist : "",
    albumArtist: selected.value.albumArtist ? resolved.albumArtist : undefined,
    album: selected.value.album ? resolved.album : undefined,
    year: selected.value.year ? resolved.year : undefined,
    lyrics: selected.value.lyrics ? resolved.lyrics : undefined,
    coverUrl: selected.value.cover ? resolved.coverUrl : undefined,
  };
  emit("apply", partial);
  // Fire-and-forget audit row. Failure here doesn't block the apply (the user
  // already got their tags merged; the row is best-effort tracking).
  try {
    await submitResult(
      {
        songMasterId: props.songMasterId || undefined,
        source: resolved.source,
        songId: resolved.songId,
        query: query.value.trim(),
        result: partial,
        mode: selected.value.cover && resolved.coverUrl
          ? (fieldKeys.some((field) => field !== "cover" && selected.value[field]) ? "both" : "cover")
          : "tags",
      },
      tagPost,
    );
  } catch {/* swallow — caller already saw the merge */}
  closePanel();
  busy.value = false;
}
</script>

<template>
  <div class="scrape-button-wrap">
    <button class="btn-secondary scrape-trigger" :disabled="busy" @click="openPanel">
      <span class="scrape-icon"><Icon name="search" /></span>
      {{ t("scrape.button") }}
    </button>

    <Teleport to="body">
    <div v-if="open" class="scrape-modal-backdrop" @click.self="closePanel">
      <div class="scrape-panel" role="dialog" aria-modal="true">
      <div class="scrape-search-row">
        <input
          v-model="query"
          class="form-input scrape-query"
          :placeholder="t('scrape.queryPlaceholder')"
          @keydown.enter.prevent="runSearch"
          @keydown.escape.prevent="closePanel"
        />
        <button class="btn-primary btn-sm" :disabled="busy" @click="runSearch">
          {{ busy ? t("common.loading") : t("scrape.searchBtn") }}
        </button>
        <button class="btn-secondary btn-sm" @click="closePanel">{{ t("common.close") }}</button>
      </div>

      <p v-if="!compact" class="scrape-hint mono-label">
        {{ t("scrape.hint") }}
      </p>

      <p v-if="error" class="scrape-error">{{ error }}</p>

      <div v-if="errors.length" class="scrape-source-errors">
        <span v-for="e in errors" :key="e.source" class="scrape-source-error">
          {{ sourceLabel[e.source] }}: {{ e.error }}
        </span>
      </div>

      <div v-if="results.length" class="scrape-results">
        <div v-for="(r, i) in results" :key="`${r.source}-${r.songId}-${i}`" class="scrape-row">
          <div class="scrape-row-main">
            <span class="scrape-source-pill" :data-src="r.source">{{ sourceLabel[r.source] }}</span>
            <span class="scrape-row-title">{{ r.title || "—" }}</span>
            <span class="scrape-row-artist">{{ r.artist || "—" }}</span>
            <span class="scrape-row-album">{{ r.album || "" }}</span>
            <span v-if="r.year" class="scrape-row-year">{{ r.year }}</span>
          </div>
          <button class="btn-secondary btn-sm" @click="showDetail(r)">{{ t("scrape.details") }}</button>
        </div>
      </div>
      <div v-if="detail" class="scrape-detail">
        <div class="scrape-detail-head"><strong>{{ t("scrape.details") }}</strong><button class="btn-primary btn-sm" @click="applyResult(detail)">{{ t("scrape.applySelected") }}</button></div>
        <div v-for="field in fieldKeys" :key="field" class="scrape-detail-field">
          <label><input v-model="selected[field]" type="checkbox" /> {{ t(`scrape.fields.${field}`) }}</label>
          <span>{{ fieldValue(detail, field) }}</span>
        </div>
      </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.scrape-button-wrap { margin: 0.7rem 0 0; }
.scrape-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.scrape-icon { font-family: var(--font-mono); color: var(--color-accent-primary); }

.scrape-panel {
  width: min(900px, calc(100vw - 2rem));
  max-height: min(82vh, 760px);
  overflow: auto;
  padding: 0.75rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.scrape-modal-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgb(0 0 0 / 70%); }
.scrape-detail { border-top: 1px solid var(--color-border-subtle); padding-top: .75rem; display:flex; flex-direction:column; gap:.4rem; }
.scrape-detail-head { display:flex; justify-content:space-between; align-items:center; }
.scrape-detail-field { display:grid; grid-template-columns: minmax(120px, 180px) 1fr; gap:.75rem; padding:.35rem; background:var(--color-bg-secondary); overflow-wrap:anywhere; }
.scrape-search-row { display: flex; gap: 0.5rem; align-items: center; }
.scrape-query { flex: 1; min-width: 180px; }

.scrape-hint {
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  margin: 0;
}
.scrape-error {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-status-error);
  margin: 0;
}
.scrape-source-errors {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.scrape-source-error {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  padding: 0.15rem 0.45rem;
  border: 1px dashed var(--color-border-subtle);
}

.scrape-results {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 260px;
  overflow-y: auto;
  border-top: 1px dashed var(--color-border-subtle);
  padding-top: 0.5rem;
}
.scrape-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
}
.scrape-row-main {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
  min-width: 0;
}
.scrape-source-pill {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
  color: var(--color-accent-primary);
}
.scrape-row-title { font-weight: 600; color: var(--color-text-primary); }
.scrape-row-artist { color: var(--color-text-secondary); font-size: var(--fs-sm); }
.scrape-row-album { color: var(--color-text-muted); font-size: var(--fs-sm); }
.scrape-row-year {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}
</style>
