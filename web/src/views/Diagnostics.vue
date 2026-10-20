<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Library diagnostics: scan → review the planned change → fix one item or the
// selected items of a category. Every fix is re-planned by the worker against
// current rows, so a stale page is refused rather than applied.
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import Icon from "../components/Icon.vue";

type DataMatch = "match" | "mismatch" | "unknown";
type FileMode = "exact" | "best";
type AlbumMode = FileMode | "auto";
type Tab = "songs" | "albums" | "folders" | "errors";
type Status = "idle" | "busy" | "done" | "error";

interface InstanceView {
  id: string; suffix: string; size: number | null; bitDepth: number | null; sampleRate: number | null;
  bitRate: number | null; duration: number | null; missing: boolean; primary: boolean; path: string;
  fingerprint: string | null; fingerprintable: boolean;
}
interface SongView {
  id: string; title: string; artist: string | null; album: string | null; albumId: string | null;
  albumArtist: string | null; track: number | null; disc: number | null; duration: number | null; instances: InstanceView[];
}
interface SongGroup {
  key: string; confidence: "exact" | "high" | "medium"; survivorId: string; songs: SongView[];
  dataMatch: DataMatch; defaultMode: FileMode; pendingFingerprints: string[];
}
interface AlbumView {
  id: string; name: string; albumArtist: string | null; songCount: number; formats: string[];
  folders: string[]; year: number | null; hasCover: boolean;
}
interface AlbumGroup {
  key: string; survivorId: string; albums: AlbumView[];
  pairs: Array<{ survivorSongId: string; duplicateSongId: string; title: string; dataMatch: DataMatch }>;
  moved: number; dataMatch: DataMatch; defaultMode: FileMode; pendingFingerprints: string[];
}
interface TrackChange { songId: string; title: string; fromDisc: number | null; fromTrack: number | null; toDisc: number | null; toTrack: number }
interface FolderIssue {
  key: string; folder: string; albumName: string; problems: string[];
  albums: Array<{ id: string; name: string; songCount: number }>;
  albumArtists: Array<{ name: string | null; count: number }>;
  proposedAlbumArtist: string | null; targetAlbumId: string; autoFixable: boolean;
  trackChanges: TrackChange[]; tracksUnresolved: boolean;
  songs: Array<{ id: string; title: string; fileName: string }>;
}
interface DataFix { action: string; value?: string | number; instanceIds?: string[] }
interface DataIssue { kind: string; id: string; label: string; detail: string; fix: DataFix | null }
interface Report {
  ok: boolean; error?: string; canDeleteFiles: boolean; generatedAt: number;
  totals: Record<Tab, number>;
  songs: SongGroup[]; albums: AlbumGroup[]; folders: FolderIssue[]; errors: DataIssue[];
}
interface ItemState { selected: boolean; survivorId: string; mode: AlbumMode; modeTouched: boolean; status: Status; message: string }

const { t } = useI18n();
const { isUser, hasPerm, edgesonicFetch, edgesonicPost } = useAuth();

const report = ref<Report | null>(null);
const scanning = ref(false);
const scanError = ref("");
const tab = ref<Tab>("songs");
const bulkProgress = ref("");
const bulkRunning = ref(false);
const states = reactive<Record<string, ItemState>>({});

const tabs: Tab[] = ["songs", "albums", "folders", "errors"];
const canUse = computed(() => isUser.value && hasPerm("maintenance_cleanup"));

function stateOf(key: string): ItemState {
  return states[key] ??= { selected: false, survivorId: "", mode: "exact", modeTouched: false, status: "idle", message: "" };
}

function errorText(error: unknown): string {
  if ((error as { status?: number })?.status === 403) return t("diagnostics.forbidden");
  return error instanceof Error ? error.message : String(error);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const data = JSON.parse(await edgesonicPost(path, body)) as T & { ok?: boolean; error?: string };
  if (data.ok === false && data.error) throw new Error(data.error);
  return data;
}

// --- scan -------------------------------------------------------------------

async function scan() {
  if (scanning.value) return;
  scanning.value = true;
  scanError.value = "";
  try {
    const data = JSON.parse(await edgesonicFetch("diagnostics/scan")) as Report;
    if (!data.ok) throw new Error(data.error || "scan failed");
    for (const key of Object.keys(states)) delete states[key];
    for (const group of data.songs) {
      Object.assign(stateOf(`song:${group.key}`), { survivorId: group.survivorId, mode: group.defaultMode, selected: group.confidence !== "medium" });
    }
    for (const group of data.albums) Object.assign(stateOf(`album:${group.key}`), { survivorId: group.survivorId, mode: "auto", selected: true });
    for (const issue of data.folders) stateOf(`folder:${issue.key}`).selected = issue.autoFixable;
    for (const issue of data.errors) stateOf(`error:${issue.kind}:${issue.id}`).selected = !!issue.fix;
    report.value = data;
  } catch (error) {
    scanError.value = errorText(error);
  } finally {
    scanning.value = false;
  }
}

// --- data-segment fingerprints ---------------------------------------------

function songGroupMatch(group: SongGroup): DataMatch {
  const primaries = group.songs.flatMap((song) => song.instances).filter((instance) => instance.primary);
  if (primaries.length < 2) return "match";
  if (primaries.some((instance) => !instance.fingerprint)) return "unknown";
  return new Set(primaries.map((instance) => instance.fingerprint)).size === 1 ? "match" : "mismatch";
}

async function computeFingerprints(ids: string[], onResult: (id: string, fingerprint: string | null) => void) {
  let queue = [...ids];
  while (queue.length > 0) {
    const data = await postJson<{ results: Array<{ id: string; fingerprint: string | null }>; remaining: string[] }>(
      "diagnostics/fingerprint", { instanceIds: queue });
    for (const result of data.results) onResult(result.id, result.fingerprint);
    if (data.remaining.length >= queue.length) break;
    queue = data.remaining;
  }
}

async function fingerprintSongGroup(group: SongGroup) {
  const state = stateOf(`song:${group.key}`);
  if (group.pendingFingerprints.length === 0) return;
  state.status = "busy";
  state.message = t("diagnostics.fingerprinting");
  try {
    const byId = new Map(group.songs.flatMap((song) => song.instances).map((instance) => [instance.id, instance]));
    await computeFingerprints(group.pendingFingerprints, (id, fingerprint) => {
      const instance = byId.get(id);
      if (instance) instance.fingerprint = fingerprint;
    });
    group.pendingFingerprints = [];
    group.dataMatch = songGroupMatch(group);
    group.defaultMode = group.dataMatch === "match" ? "best" : "exact";
    if (!state.modeTouched) state.mode = group.defaultMode;
    state.status = "idle";
    state.message = "";
  } catch (error) {
    state.status = "error";
    state.message = errorText(error);
  }
}

async function fingerprintAlbumGroup(group: AlbumGroup) {
  const state = stateOf(`album:${group.key}`);
  if (group.pendingFingerprints.length === 0) return;
  state.status = "busy";
  state.message = t("diagnostics.fingerprinting");
  try {
    await computeFingerprints(group.pendingFingerprints, () => {});
    group.pendingFingerprints = [];
    state.status = "idle";
    state.message = t("diagnostics.fingerprintedAuto");
  } catch (error) {
    state.status = "error";
    state.message = errorText(error);
  }
}

// --- fixes ------------------------------------------------------------------

async function mergeSongGroup(group: SongGroup) {
  const state = stateOf(`song:${group.key}`);
  if (state.status === "busy" || state.status === "done") return;
  await fingerprintSongGroup(group);
  if (state.status === "error") return;
  state.status = "busy";
  state.message = "";
  try {
    const songIds = group.songs.map((song) => song.id).filter((id) => id !== state.survivorId);
    const data = await postJson<{ ok: boolean; retired: unknown[]; failed: Array<{ error?: string }> }>(
      "diagnostics/songs/merge", { survivorId: state.survivorId, songIds, mode: state.mode });
    if (data.failed.length) throw new Error(data.failed.map((item) => item.error).join("; "));
    state.status = "done";
    state.message = t("diagnostics.songs.merged", { files: data.retired.length });
  } catch (error) {
    state.status = "error";
    state.message = errorText(error);
  }
}

async function mergeAlbumGroup(group: AlbumGroup) {
  const state = stateOf(`album:${group.key}`);
  if (state.status === "busy" || state.status === "done") return;
  if (state.mode === "auto") await fingerprintAlbumGroup(group);
  if (state.status === "error") return;
  state.status = "busy";
  state.message = "";
  try {
    const albumIds = group.albums.map((album) => album.id).filter((id) => id !== state.survivorId);
    const data = await postJson<{ songs: Array<{ songId: string; mode: FileMode; retire: number }> }>(
      "diagnostics/albums/merge", { survivorId: state.survivorId, albumIds, mode: state.mode });
    let removed = 0;
    const failures: string[] = [];
    for (const song of data.songs.filter((item) => item.retire > 0)) {
      state.message = t("diagnostics.albums.retiring", { done: removed, total: data.songs.length });
      try {
        const result = await postJson<{ retired: unknown[]; failed: Array<{ error?: string }> }>(
          "diagnostics/songs/retire", { songId: song.songId, mode: song.mode });
        removed += result.retired.length;
        failures.push(...result.failed.map((item) => item.error ?? ""));
      } catch (error) {
        failures.push(errorText(error));
      }
    }
    if (failures.length) throw new Error(failures.join("; "));
    state.status = "done";
    state.message = t("diagnostics.albums.merged", { songs: data.songs.length, files: removed });
  } catch (error) {
    state.status = "error";
    state.message = errorText(error);
  }
}

async function fixFolder(issue: FolderIssue) {
  const state = stateOf(`folder:${issue.key}`);
  if (state.status === "busy" || state.status === "done" || !issue.autoFixable) return;
  state.status = "busy";
  state.message = "";
  try {
    const data = await postJson<{ tracksChanged: number }>("diagnostics/folders/fix", { songIds: issue.songs.map((song) => song.id) });
    state.status = "done";
    state.message = t("diagnostics.folders.fixed", { tracks: data.tracksChanged });
  } catch (error) {
    state.status = "error";
    state.message = errorText(error);
  }
}

async function fixErrors(kind: string, issues: DataIssue[]) {
  const pending = issues.filter((issue) => issue.fix && stateOf(`error:${kind}:${issue.id}`).status !== "done");
  for (let i = 0; i < pending.length; i += 100) {
    const chunk = pending.slice(i, i + 100);
    for (const issue of chunk) stateOf(`error:${kind}:${issue.id}`).status = "busy";
    try {
      const data = await postJson<{ items: Array<{ id: string; ok: boolean; error?: string }> }>(
        "diagnostics/errors/fix", { kind, ids: chunk.map((issue) => issue.id) });
      for (const item of data.items) {
        const state = stateOf(`error:${kind}:${item.id}`);
        state.status = item.ok ? "done" : "error";
        state.message = item.ok ? "" : item.error ?? "";
      }
    } catch (error) {
      for (const issue of chunk) Object.assign(stateOf(`error:${kind}:${issue.id}`), { status: "error", message: errorText(error) });
    }
  }
}

// --- bulk -------------------------------------------------------------------

const errorGroups = computed(() => {
  const groups = new Map<string, DataIssue[]>();
  for (const issue of report.value?.errors ?? []) groups.set(issue.kind, [...(groups.get(issue.kind) ?? []), issue]);
  return [...groups].map(([kind, issues]) => ({ kind, issues }));
});

const selectedCount = computed(() => {
  const data = report.value;
  if (!data) return 0;
  const keys = tab.value === "songs" ? data.songs.map((group) => `song:${group.key}`)
    : tab.value === "albums" ? data.albums.map((group) => `album:${group.key}`)
    : tab.value === "folders" ? data.folders.map((issue) => `folder:${issue.key}`)
    : data.errors.map((issue) => `error:${issue.kind}:${issue.id}`);
  return keys.filter((key) => stateOf(key).selected && stateOf(key).status !== "done").length;
});

async function fixSelected() {
  const data = report.value;
  if (!data || bulkRunning.value || selectedCount.value === 0) return;
  if (!window.confirm(t(`diagnostics.confirm.${tab.value}`, { n: selectedCount.value }))) return;
  bulkRunning.value = true;
  try {
    if (tab.value === "songs") {
      const groups = data.songs.filter((group) => stateOf(`song:${group.key}`).selected);
      for (const [index, group] of groups.entries()) {
        bulkProgress.value = `${index + 1}/${groups.length}`;
        await mergeSongGroup(group);
      }
    } else if (tab.value === "albums") {
      const groups = data.albums.filter((group) => stateOf(`album:${group.key}`).selected);
      for (const [index, group] of groups.entries()) {
        bulkProgress.value = `${index + 1}/${groups.length}`;
        await mergeAlbumGroup(group);
      }
    } else if (tab.value === "folders") {
      const issues = data.folders.filter((issue) => stateOf(`folder:${issue.key}`).selected);
      for (const [index, issue] of issues.entries()) {
        bulkProgress.value = `${index + 1}/${issues.length}`;
        await fixFolder(issue);
      }
    } else {
      for (const group of errorGroups.value) {
        bulkProgress.value = t(`diagnostics.errors.kinds.${group.kind}`);
        await fixErrors(group.kind, group.issues.filter((issue) => stateOf(`error:${issue.kind}:${issue.id}`).selected));
      }
    }
  } finally {
    bulkRunning.value = false;
    bulkProgress.value = "";
  }
}

function setMode(key: string, mode: AlbumMode) {
  const state = stateOf(key);
  state.mode = mode;
  state.modeTouched = true;
}

// --- formatting -------------------------------------------------------------

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "—";
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatQuality(instance: InstanceView): string {
  const parts = [instance.suffix.toUpperCase()];
  if (instance.bitDepth && instance.sampleRate) parts.push(`${instance.bitDepth}bit/${(instance.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")}kHz`);
  else if (instance.bitRate) parts.push(`${instance.bitRate}kbps`);
  return parts.join(" ");
}

function formatPosition(disc: number | null, track: number | null): string {
  if (!track) return "—";
  return disc ? `${disc}-${track}` : String(track);
}

function fixText(fix: DataFix | null): string {
  if (!fix) return t("diagnostics.errors.fix.manual");
  return t(`diagnostics.errors.fix.${fix.action}`, {
    value: fix.action === "setDuration" ? formatDuration(Number(fix.value)) : fix.value ?? "",
    n: fix.instanceIds?.length ?? 0,
  });
}

function statusClass(status: Status): string {
  return status === "done" ? "success" : status === "error" ? "error" : status === "busy" ? "warning" : "";
}
</script>

<template>
  <div class="diagnostics">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("diagnostics.label") }}</div>
        <h1 class="page-title">{{ t("diagnostics.title") }}</h1>
        <p class="page-description">{{ t("diagnostics.intro") }}</p>
      </div>
      <div class="header-actions">
        <RouterLink to="/tools" class="btn-secondary btn-sm">{{ t("diagnostics.back") }}</RouterLink>
        <button v-if="canUse" type="button" class="btn-primary btn-sm" :disabled="scanning || bulkRunning" @click="scan">
          <Icon name="refresh" size="16" />
          {{ scanning ? t("diagnostics.scanning") : report ? t("diagnostics.rescan") : t("diagnostics.scan") }}
        </button>
      </div>
    </div>

    <div v-if="!canUse" class="empty-state">
      <div class="empty-state-icon"><Icon name="lock" /></div>
      <div>{{ t("diagnostics.noPermission") }}</div>
    </div>

    <template v-else>
      <p v-if="scanError" class="diag-error">{{ scanError }}</p>
      <div v-if="!report" class="card diag-empty">
        <p>{{ scanning ? t("diagnostics.scanningHint") : t("diagnostics.emptyHint") }}</p>
      </div>

      <template v-else>
        <p class="diag-note">{{ t("diagnostics.tagNote") }}</p>
        <p v-if="!report.canDeleteFiles" class="diag-note warn">{{ t("diagnostics.noDeletePermission") }}</p>

        <div class="diag-tabs" role="tablist">
          <button v-for="key in tabs" :key="key" type="button" role="tab" class="seg-btn" :class="{ active: tab === key }"
            :aria-selected="tab === key" @click="tab = key">
            {{ t(`diagnostics.tabs.${key}`) }} <span class="tab-count">{{ report.totals[key] }}</span>
          </button>
        </div>

        <div class="diag-toolbar">
          <span class="muted">
            {{ t("diagnostics.shown", { shown: report[tab].length, total: report.totals[tab] }) }}
          </span>
          <span v-if="bulkProgress" class="status-badge warning">{{ bulkProgress }}</span>
          <button type="button" class="btn-primary btn-sm" :disabled="bulkRunning || selectedCount === 0" @click="fixSelected">
            {{ t("diagnostics.fixSelected", { n: selectedCount }) }}
          </button>
        </div>

        <!-- Duplicate songs -->
        <section v-if="tab === 'songs'" class="diag-list">
          <p v-if="report.songs.length === 0" class="muted">{{ t("diagnostics.none") }}</p>
          <article v-for="group in report.songs" :key="group.key" class="card diag-item" :class="{ done: stateOf(`song:${group.key}`).status === 'done' }">
            <header class="diag-item-head">
              <label class="diag-check"><input v-model="stateOf(`song:${group.key}`).selected" type="checkbox" /></label>
              <strong class="diag-item-title">{{ group.songs[0].title }}</strong>
              <span class="status-badge" :class="group.confidence === 'medium' ? 'warning' : 'info'">{{ t(`diagnostics.confidence.${group.confidence}`) }}</span>
              <span class="status-badge" :class="group.dataMatch === 'match' ? 'success' : group.dataMatch === 'mismatch' ? 'warning' : 'muted'">{{ t(`diagnostics.dataMatch.${group.dataMatch}`) }}</span>
            </header>
            <table class="diag-table">
              <thead>
                <tr><th>{{ t("diagnostics.keep") }}</th><th>{{ t("diagnostics.col.song") }}</th><th>{{ t("diagnostics.col.album") }}</th><th class="num">{{ t("diagnostics.col.duration") }}</th><th>{{ t("diagnostics.col.files") }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="song in group.songs" :key="song.id">
                  <td><input v-model="stateOf(`song:${group.key}`).survivorId" type="radio" :name="`keep-${group.key}`" :value="song.id" /></td>
                  <td>{{ song.title }}<div class="muted small">{{ song.artist }}</div></td>
                  <td>{{ song.album }}<div class="muted small">{{ formatPosition(song.disc, song.track) }}</div></td>
                  <td class="num">{{ formatDuration(song.duration) }}</td>
                  <td>
                    <div v-for="instance in song.instances" :key="instance.id" class="file-line" :title="instance.path">
                      <span class="file-quality">{{ formatQuality(instance) }}</span>
                      <span class="muted small">{{ formatSize(instance.size) }}</span>
                      <span v-if="instance.missing" class="status-badge error">{{ t("diagnostics.missing") }}</span>
                      <span v-if="!instance.primary" class="muted small">{{ t("diagnostics.derived") }}</span>
                      <span v-if="instance.fingerprint" class="mono small" :title="instance.fingerprint">#{{ instance.fingerprint.slice(-6) }}</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <footer class="diag-actions">
              <select class="form-input diag-mode" :value="stateOf(`song:${group.key}`).mode"
                @change="setMode(`song:${group.key}`, ($event.target as HTMLSelectElement).value as FileMode)">
                <option value="exact">{{ t("diagnostics.mode.exact") }}</option>
                <option value="best">{{ t("diagnostics.mode.best") }}</option>
              </select>
              <span class="diag-status" :class="statusClass(stateOf(`song:${group.key}`).status)">{{ stateOf(`song:${group.key}`).message }}</span>
              <button v-if="group.pendingFingerprints.length" type="button" class="btn-secondary btn-sm"
                :disabled="stateOf(`song:${group.key}`).status === 'busy'" @click="fingerprintSongGroup(group)">
                {{ t("diagnostics.fingerprint") }}
              </button>
              <button type="button" class="btn-primary btn-sm" :disabled="['busy', 'done'].includes(stateOf(`song:${group.key}`).status)" @click="mergeSongGroup(group)">
                {{ t("diagnostics.songs.merge") }}
              </button>
            </footer>
          </article>
        </section>

        <!-- Duplicate albums -->
        <section v-else-if="tab === 'albums'" class="diag-list">
          <p v-if="report.albums.length === 0" class="muted">{{ t("diagnostics.none") }}</p>
          <article v-for="group in report.albums" :key="group.key" class="card diag-item" :class="{ done: stateOf(`album:${group.key}`).status === 'done' }">
            <header class="diag-item-head">
              <label class="diag-check"><input v-model="stateOf(`album:${group.key}`).selected" type="checkbox" /></label>
              <strong class="diag-item-title">{{ group.albums[0].name }}</strong>
              <span class="status-badge" :class="group.dataMatch === 'match' ? 'success' : group.dataMatch === 'mismatch' ? 'warning' : 'muted'">{{ t(`diagnostics.dataMatch.${group.dataMatch}`) }}</span>
              <span class="muted small">{{ t("diagnostics.albums.summary", { pairs: group.pairs.length, moved: group.moved }) }}</span>
            </header>
            <table class="diag-table">
              <thead>
                <tr><th>{{ t("diagnostics.keep") }}</th><th>{{ t("diagnostics.col.album") }}</th><th class="num">{{ t("diagnostics.col.songs") }}</th><th>{{ t("diagnostics.col.formats") }}</th><th>{{ t("diagnostics.col.folder") }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="album in group.albums" :key="album.id">
                  <td><input v-model="stateOf(`album:${group.key}`).survivorId" type="radio" :name="`keep-${group.key}`" :value="album.id" /></td>
                  <td>{{ album.name }}<div class="muted small">{{ album.albumArtist }}<template v-if="album.year"> · {{ album.year }}</template></div></td>
                  <td class="num">{{ album.songCount }}</td>
                  <td class="mono small">{{ album.formats.join(", ").toUpperCase() }}</td>
                  <td class="small path-cell">{{ album.folders.join(" · ") }}</td>
                </tr>
              </tbody>
            </table>
            <footer class="diag-actions">
              <select class="form-input diag-mode" :value="stateOf(`album:${group.key}`).mode"
                @change="setMode(`album:${group.key}`, ($event.target as HTMLSelectElement).value as AlbumMode)">
                <option value="auto">{{ t("diagnostics.mode.auto") }}</option>
                <option value="exact">{{ t("diagnostics.mode.exact") }}</option>
                <option value="best">{{ t("diagnostics.mode.best") }}</option>
              </select>
              <span class="diag-status" :class="statusClass(stateOf(`album:${group.key}`).status)">{{ stateOf(`album:${group.key}`).message }}</span>
              <button v-if="group.pendingFingerprints.length" type="button" class="btn-secondary btn-sm"
                :disabled="stateOf(`album:${group.key}`).status === 'busy'" @click="fingerprintAlbumGroup(group)">
                {{ t("diagnostics.fingerprint") }}
              </button>
              <button type="button" class="btn-primary btn-sm" :disabled="['busy', 'done'].includes(stateOf(`album:${group.key}`).status)" @click="mergeAlbumGroup(group)">
                {{ t("diagnostics.albums.merge") }}
              </button>
            </footer>
          </article>
        </section>

        <!-- Folder albums -->
        <section v-else-if="tab === 'folders'" class="diag-list">
          <p v-if="report.folders.length === 0" class="muted">{{ t("diagnostics.none") }}</p>
          <article v-for="issue in report.folders" :key="issue.key" class="card diag-item" :class="{ done: stateOf(`folder:${issue.key}`).status === 'done' }">
            <header class="diag-item-head">
              <label class="diag-check"><input v-model="stateOf(`folder:${issue.key}`).selected" type="checkbox" :disabled="!issue.autoFixable" /></label>
              <strong class="diag-item-title">{{ issue.albumName }}</strong>
              <span v-for="problem in issue.problems" :key="problem" class="status-badge warning">{{ t(`diagnostics.folders.problems.${problem}`) }}</span>
            </header>
            <p class="mono small path-cell">{{ issue.folder || "/" }}</p>
            <div class="folder-grid">
              <div>
                <div class="mono-label">{{ t("diagnostics.folders.albumArtists") }}</div>
                <div v-for="entry in issue.albumArtists" :key="entry.name ?? ''" class="small">
                  {{ entry.name ?? t("diagnostics.folders.noAlbumArtist") }} <span class="muted">×{{ entry.count }}</span>
                </div>
                <div class="folder-proposal">
                  →
                  <strong v-if="issue.proposedAlbumArtist">{{ issue.proposedAlbumArtist }}</strong>
                  <span v-else class="muted">{{ t("diagnostics.folders.manual") }}</span>
                </div>
              </div>
              <div v-if="issue.albums.length > 1">
                <div class="mono-label">{{ t("diagnostics.folders.albums") }}</div>
                <div v-for="album in issue.albums" :key="album.id" class="small">
                  {{ album.name }} <span class="muted">×{{ album.songCount }}</span>
                  <span v-if="album.id === issue.targetAlbumId" class="status-badge info">{{ t("diagnostics.keep") }}</span>
                </div>
              </div>
            </div>
            <p v-if="issue.problems.includes('duplicateCopies')" class="diag-note">{{ t("diagnostics.folders.duplicateHint") }}</p>
            <p v-if="issue.tracksUnresolved" class="diag-note warn">{{ t("diagnostics.folders.tracksUnresolved") }}</p>
            <table v-if="issue.trackChanges.length" class="diag-table">
              <thead><tr><th>{{ t("diagnostics.col.song") }}</th><th class="num">{{ t("diagnostics.folders.from") }}</th><th class="num">{{ t("diagnostics.folders.to") }}</th></tr></thead>
              <tbody>
                <tr v-for="change in issue.trackChanges" :key="change.songId">
                  <td>{{ change.title }}</td>
                  <td class="num mono">{{ formatPosition(change.fromDisc, change.fromTrack) }}</td>
                  <td class="num mono">{{ formatPosition(change.toDisc, change.toTrack) }}</td>
                </tr>
              </tbody>
            </table>
            <footer class="diag-actions">
              <span class="diag-status" :class="statusClass(stateOf(`folder:${issue.key}`).status)">{{ stateOf(`folder:${issue.key}`).message }}</span>
              <button type="button" class="btn-primary btn-sm"
                :disabled="!issue.autoFixable || ['busy', 'done'].includes(stateOf(`folder:${issue.key}`).status)" @click="fixFolder(issue)">
                {{ t("diagnostics.folders.fix") }}
              </button>
            </footer>
          </article>
        </section>

        <!-- Data errors -->
        <section v-else class="diag-list">
          <p v-if="errorGroups.length === 0" class="muted">{{ t("diagnostics.none") }}</p>
          <article v-for="group in errorGroups" :key="group.kind" class="card diag-item">
            <header class="diag-item-head">
              <strong class="diag-item-title">{{ t(`diagnostics.errors.kinds.${group.kind}`) }}</strong>
              <span class="status-badge info">{{ group.issues.length }}</span>
              <button v-if="group.issues.some((issue) => issue.fix)" type="button" class="btn-secondary btn-sm push-right"
                :disabled="bulkRunning" @click="fixErrors(group.kind, group.issues)">
                {{ t("diagnostics.errors.fixKind") }}
              </button>
            </header>
            <p class="muted small">{{ t(`diagnostics.errors.hints.${group.kind}`) }}</p>
            <table class="diag-table">
              <tbody>
                <tr v-for="issue in group.issues" :key="issue.id">
                  <td class="check-cell"><input v-model="stateOf(`error:${issue.kind}:${issue.id}`).selected" type="checkbox" :disabled="!issue.fix" /></td>
                  <td>{{ issue.label }}<div v-if="issue.detail" class="muted small mono">{{ issue.detail }}</div></td>
                  <td class="small">{{ fixText(issue.fix) }}</td>
                  <td class="small diag-status" :class="statusClass(stateOf(`error:${issue.kind}:${issue.id}`).status)">
                    {{ stateOf(`error:${issue.kind}:${issue.id}`).status === "done" ? t("diagnostics.fixed") : stateOf(`error:${issue.kind}:${issue.id}`).message }}
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.diagnostics { max-width: 1120px; min-width: 0; margin: 0 auto; padding-bottom: 2rem; }
.diagnostics .page-header { align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
.page-description { max-width: 72ch; margin: 0.45rem 0 0; color: var(--color-text-secondary); line-height: 1.5; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; margin-left: auto; }
.header-actions .btn-primary { display: inline-flex; align-items: center; gap: 0.35rem; }
.diag-empty { padding: 1.2rem; color: var(--color-text-secondary); }
.diag-error { color: var(--color-status-error); }
.diag-note { margin: 0 0 0.8rem; color: var(--color-text-secondary); font-size: var(--fs-sm); line-height: 1.5; }
.diag-note.warn { color: var(--color-status-warning); }

.diag-tabs { display: flex; flex-wrap: wrap; border: 1px solid var(--color-border-subtle); margin-bottom: 0.9rem; width: fit-content; max-width: 100%; }
.seg-btn {
  background: none; border: none; padding: 0.45rem 0.9rem; cursor: pointer;
  font-size: var(--fs-sm); color: var(--color-text-secondary);
  border-right: 1px solid var(--color-border-subtle);
}
.seg-btn:last-child { border-right: none; }
.seg-btn:hover { color: var(--color-text-primary); }
.seg-btn.active { background: var(--color-accent-dim); color: var(--color-accent-primary); }
.tab-count { font-family: var(--font-mono); font-size: var(--fs-xs); margin-left: 0.25rem; }

.diag-toolbar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.9rem; flex-wrap: wrap; }
.diag-toolbar .btn-primary { margin-left: auto; }
.diag-list { display: flex; flex-direction: column; gap: 0.9rem; }
.diag-item { padding: 0.9rem 1rem; min-width: 0; }
.diag-item.done { opacity: 0.55; }
.diag-item-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
.diag-item-title { font-size: var(--fs-md); min-width: 0; overflow-wrap: anywhere; }
.diag-check { display: inline-flex; }
.push-right { margin-left: auto; }

.diag-table { width: 100%; border-collapse: collapse; margin-bottom: 0.6rem; display: block; overflow-x: auto; }
.diag-table th, .diag-table td { padding: 0.4rem 0.55rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--color-border-subtle); font-size: var(--fs-sm); }
.diag-table th { color: var(--color-text-muted); font-weight: 500; white-space: nowrap; }
.diag-table .num { text-align: right; font-family: var(--font-mono); white-space: nowrap; }
.check-cell { width: 28px; }
.file-line { display: flex; gap: 0.45rem; align-items: baseline; flex-wrap: wrap; }
.file-quality { font-family: var(--font-mono); font-size: var(--fs-xs); }
.path-cell { overflow-wrap: anywhere; color: var(--color-text-secondary); }
.small { font-size: var(--fs-xs); }
.mono { font-family: var(--font-mono); }
.muted { color: var(--color-text-muted); }

.folder-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.8rem; margin: 0.4rem 0 0.7rem; }
.folder-grid .mono-label { margin-bottom: 0.25rem; }
.folder-proposal { margin-top: 0.3rem; font-size: var(--fs-sm); }

.diag-actions { display: flex; align-items: center; gap: 0.6rem; justify-content: flex-end; flex-wrap: wrap; }
.diag-mode { width: auto; min-width: 0; max-width: 100%; font-size: var(--fs-sm); }
.diag-status { font-size: var(--fs-sm); color: var(--color-text-secondary); margin-right: auto; overflow-wrap: anywhere; }
.diag-status.success { color: var(--color-status-success); }
.diag-status.error { color: var(--color-status-error); }
.diag-status.warning { color: var(--color-status-warning); }

@media (max-width: 760px) {
  .header-actions { margin-left: 0; }
  .diag-item { padding: 0.75rem; }
  .diag-actions { justify-content: stretch; }
  .diag-actions .btn-primary, .diag-actions .btn-secondary { flex: 1; }
}
</style>
