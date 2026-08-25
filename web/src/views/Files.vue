
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import type { CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, formatSize } from "../api";
import { mapConcurrent } from "../lib/concurrency";
import { normalizeForMatch } from "../lib/trackMatch";
import TagEditor from "../components/TagEditor.vue";
import ScrapeButton from "../components/ScrapeButton.vue";
import type { ScrapeResult } from "../lib/scrape";
import { extractMetadata } from "../lib/metadata";
import Icon from "../components/Icon.vue";

const { t } = useI18n();
const { authFetch, storageFetch, storagePost, tagFetch, uploadFile, crossCopy, writeTags, batchWriteTags, tidyFolder, restUrl, hasPerm, coverArtUrl, submitMetadata } = useAuth();

interface StorageSource { id: string; type: string; name: string; baseUrl: string; }
interface DirEntry { name: string; }
interface FileEntry { name: string; size: number; contentType: string | null; uri: string; }

const sources = ref<StorageSource[]>([]);
const currentSource = ref("r2");

const path = ref("music");
const dirs = ref<DirEntry[]>([]);
const files = ref<FileEntry[]>([]);
const loading = ref(false);
type FileSortKey = "name" | "size" | "type";
const fileSortKey = ref<FileSortKey>("name");
const fileSortDirection = ref<"asc" | "desc">("asc");
const foldersFirst = ref(true);

const showUpload = ref(false);
const uploadInput = ref<HTMLInputElement | null>(null);
const syncUploadInput = ref<HTMLInputElement | null>(null);
type UploadKind = "audio" | "lyrics" | "variant" | "sidecar" | "encrypted";
interface UploadItem { file: File; kind: UploadKind; stem: string; relativeDir: string; }
const uploadQueue = ref<UploadItem[]>([]);
const uploadProgressList = ref<number[]>([]); // 0-100 per file; -1 = failed
const uploadDoneCount = ref(0);
const uploadFailedNames = ref<string[]>([]);
const uploadBusy = ref(false);
const uploadMsg = ref("");
const uploadErr = ref(false);
const includeLyrics = ref(true);
const includeVariants = ref(true);
const UPLOAD_CONCURRENCY = 3;
const AUDIO_EXTENSIONS = new Set(["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "aiff", "alac", "ape", "wma"]);
const LYRIC_EXTENSIONS = new Set(["lrc", "ttml", "krc"]);
const OPENYYY_ENCRYPTED_EXTENSIONS = new Set([
  "ncm", "uc", "mg3d", "kwm", "xm", "x2m", "x3m", "tm0", "tm2", "tm3", "tm6", "cache",
  "qmc0", "qmc2", "qmc3", "qmc4", "qmc6", "qmc8", "qmcflac", "qmcogg", "tkm",
  "bkcmp3", "bkcm4a", "bkcflac", "bkcwav", "bkcape", "bkcogg", "bkcwma",
  "mggl", "mflac", "mflac0", "mflach", "mgg", "mgg0", "mgg1", "mmp4",
  "666c6163", "6d7033", "6f6767", "6d3461", "776176", "kgm", "kgma", "vpr",
]);

interface CrossCopyItem { file: FileEntry; status: "pending" | "copying" | "done" | "failed"; error?: string; }
const crossCopyModal = ref<{ files: FileEntry[] } | null>(null);
const crossCopyDestSource = ref("r2");
const crossCopyDestPath = ref("");
const crossCopyBusy = ref(false);
const crossCopyQueue = ref<CrossCopyItem[]>([]);
const selectedFiles = ref<Set<string>>(new Set()); // keyed by FileEntry.uri
const selectedDirs = ref<Set<string>>(new Set());
const CROSS_COPY_CONCURRENCY = 3;

const scanning = ref(false);
const scanProcessed = ref(0);
const scanRemaining = ref<number | null>(null);

const pendingCount = ref(0);

const renamingFile = ref<string | null>(null); // file name currently being renamed
const renamingDir = ref<string | null>(null); // folder name currently being renamed
const renameInput = ref("");
const opModal = ref<{ files: FileEntry[]; dirs: string[]; mode: "move" | "copy"; base: string } | null>(null);
const opBusy = ref(false);
const opQueue = ref<Array<{ kind: "file" | "dir"; name: string; key: string; status: "pending" | "running" | "done" | "failed"; error?: string }>>([]);
const OP_CONCURRENCY = 3;
interface DestNode { name: string; path: string; children: DestNode[] | null; expanded: boolean; loading: boolean }
const destTreeRoot = ref<DestNode | null>(null);
const opDestSelected = ref("");
const treeNewFolderName = ref("");
const treeNewFolderBusy = ref(false);
const deleteConfirmModal = ref<{ files: FileEntry[]; dirs: string[]; base: string } | null>(null);

const newFolderModal = ref(false);
const newFolderName = ref("");
const newFolderBusy = ref(false);

const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

import { useDemoMode } from "../stores/demoMode";

const demoMode = useDemoMode();
// Upload file-type filter. The default covers what belongs in a music
// folder: audio plus the lyric sidecars the player reads back, plain text
// and cover-style images — the same set the upload endpoint accepts without
// allow_all_file_types. When the server has enabled that flag AND the user
// explicitly picks "all" from the dropdown, we drop the accept attribute so
// any file can be selected. The backend still validates the suffix
// regardless, so this is purely a UX hint.
const COMPANION_ACCEPT = ".lrc,.ttml,.krc,.txt,image/*";
const OPENYYY_ACCEPT = Array.from(OPENYYY_ENCRYPTED_EXTENSIONS, (ext) => `.${ext}`).join(",");
const uploadAcceptMode = ref<"music" | "all">("music");
const uploadAccept = computed(() => (uploadAcceptMode.value === "music" ? `audio/*,${COMPANION_ACCEPT},${OPENYYY_ACCEPT}` : undefined));
// Parse metadata on upload (default on). When off, the file lands in
// R2/D1 with tag_scanned=0 and a manual scan picks it up later.
const uploadParseMetadata = ref(true);
const canSelectAllFiles = computed(() => demoMode.allowAllFileTypes);

// Pre-transcode options, asked per-upload instead of as a global Settings
// default (nothing ever consumed the old global setting — see profiles.ts).
// Collapsed by default; expanding it lets the uploader pick which
// additional playback qualities should be pre-generated right away instead
// of waiting for the first /rest/stream request at that quality.
const showPreTranscode = ref(false);
const preTranscodeProfiles = ref<string[]>([]);
const PRE_TRANSCODE_PROFILES: { id: string; label: string }[] = [
  { id: "mp3-128k", label: "MP3 128 kbps" },
  { id: "mp3-192k", label: "MP3 192 kbps" },
  { id: "aac-128k", label: "AAC 128 kbps" },
  { id: "opus-128k", label: "Opus 128 kbps" },
  { id: "flac-lossless", label: "FLAC" },
  { id: "wav-lossless", label: "WAV" },
];

const canUpload = computed(() => hasPerm("upload"));
const canScan = computed(() => hasPerm("manage_files"));
const isR2 = computed(() => currentSource.value === "r2");
const crumbs = computed(() => (path.value ? path.value.split("/") : []));
const uploadTarget = computed(() => (currentSource.value === "r2" ? "r2" : "webdav"));

const selectedDirEntries = computed(() => dirs.value.filter((d) => selectedDirs.value.has(d.name)));
const selectedFileEntries = computed(() => files.value.filter((f) => selectedFiles.value.has(f.uri)));
const selectedTotal = computed(() => selectedDirEntries.value.length + selectedFileEntries.value.length);
const hasDirSelection = computed(() => selectedDirEntries.value.length > 0);
const allSelected = computed(() => selectedTotal.value > 0 && selectedTotal.value === dirs.value.length + files.value.length);
const activeUploadItems = computed(() => uploadQueue.value.filter((item) =>
  item.kind !== "encrypted" && (item.kind !== "lyrics" || includeLyrics.value) && (item.kind !== "variant" || includeVariants.value),
));

function suffixOf(name: string) { return name.split(".").pop()?.toLowerCase() || ""; }
function stemOf(name: string) { return name.replace(/\.[^.]+$/, "").toLocaleLowerCase(); }
function relativeDirOf(file: File) {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
  const slash = relative.lastIndexOf("/");
  return slash > -1 ? relative.slice(0, slash) : "";
}
function classifyUploadItems(selected: File[]): UploadItem[] {
  const audioStems = new Map<string, number>();
  return selected.map((file) => {
    const suffix = suffixOf(file.name);
    const stem = stemOf(file.name);
    let kind: UploadKind = "sidecar";
    if (LYRIC_EXTENSIONS.has(suffix)) kind = "lyrics";
    else if (OPENYYY_ENCRYPTED_EXTENSIONS.has(suffix)) kind = "encrypted";
    else if (AUDIO_EXTENSIONS.has(suffix)) {
      const count = audioStems.get(stem) || 0;
      audioStems.set(stem, count + 1);
      kind = count === 0 ? "audio" : "variant";
    }
    return { file, kind, stem, relativeDir: relativeDirOf(file) };
  });
}
function uploadKindLabel(kind: UploadKind) { return t(`files.uploadKinds.${kind}`); }
function uploadPathFor(item: UploadItem) { return item.relativeDir ? joinPath(path.value, item.relativeDir) : path.value || undefined; }
function openOpenYYY() { window.open("https://openyyy.com", "_blank", "noopener,noreferrer"); }

function clearSelection() {
  selectedFiles.value.clear();
  selectedDirs.value.clear();
}

function toggleDirSelect(d: DirEntry) {
  if (selectedDirs.value.has(d.name)) selectedDirs.value.delete(d.name);
  else selectedDirs.value.add(d.name);
}

function toggleSelectAll() {
  if (allSelected.value) { clearSelection(); return; }
  selectedDirs.value = new Set(dirs.value.map((d) => d.name));
  selectedFiles.value = new Set(files.value.map((f) => f.uri));
}

function shortUrl(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

function sourceLabel(id: string): string {
  if (id === "r2") return "R2";
  const s = sources.value.find((x) => x.id === id);
  if (!s) return id;
  return s.name || `${s.type.toUpperCase()} · ${shortUrl(s.baseUrl)}`;
}

function r2Key(f: FileEntry): string {
  return f.uri.startsWith("r2://") ? f.uri.slice(5) : f.uri;
}

async function loadSources() {
  try {
    const xml = await storageFetch("sources/list");
    sources.value = parseXmlAttrs(xml, "source")
      .filter((s) => s.enabled === "true" || s.enabled === "1")
      // R2 already has its own dedicated hardcoded tab above (id='r2',
      // wired to the isR2/r2Key() code path) — /storage/sources/list may
      // also include a synthesised R2 row (id='r2-local') so it's editable
      // from the Sources page. Filtering it out here avoids rendering two
      // separate "R2" tabs for what the user experiences as one storage.
      .filter((s) => s.type !== "r2")
      .map((s) => ({ id: s.id || "", type: s.type || "", name: s.name || "", baseUrl: s.baseUrl || "" }));
  } catch { sources.value = []; }
}

async function loadDir() {
  loading.value = true;
  renamingFile.value = null;
  renamingDir.value = null;
  try {
    const text = await storageFetch("files/list", { source: currentSource.value, path: path.value });
    const data = JSON.parse(text);
    if (data.ok !== true) throw new Error(data.error || "list failed");
    dirs.value = (data.dirs || []).slice();
    files.value = (data.files || []).slice();
    applyFileSort();
  } catch {
    dirs.value = [];
    files.value = [];
    showToast(t("files.loadFailed"), "error");
  } finally {
    loading.value = false;
  }
}

function compareEntries(a: FileEntry, b: FileEntry) {
  let result: number;
  if (fileSortKey.value === "size") result = a.size - b.size;
  else if (fileSortKey.value === "type") result = suffixOf(a.name).localeCompare(suffixOf(b.name)) || a.name.localeCompare(b.name);
  else result = a.name.localeCompare(b.name);
  return fileSortDirection.value === "asc" ? result : -result;
}
function applyFileSort() {
  dirs.value = dirs.value.slice().sort((a, b) => fileSortDirection.value === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  files.value = files.value.slice().sort(compareEntries);
}
watch([fileSortKey, fileSortDirection, foldersFirst], applyFileSort);

function selectSource(id: string) {
  currentSource.value = id;
  path.value = id === "r2" ? "music" : "";
  clearSelection();
  loadDir();
  // the count tracks the active source.
  loadPending();
}

async function loadPending() {
  if (!currentSource.value || currentSource.value === "r2") {
    pendingCount.value = 0;
    return;
  }
  try {
    const text = await storageFetch("scan/pending", {
      source: currentSource.value,
      limit: "1",
    });
    const data = JSON.parse(text);
    pendingCount.value = data?.ok ? (data.total ?? 0) : 0;
  } catch {
    pendingCount.value = 0;
  }
}

function enterDir(name: string) {
  path.value = path.value ? `${path.value}/${name}` : name;
  clearSelection();
  loadDir();
}

function goCrumb(index: number) {
  path.value = index < 0 ? "" : crumbs.value.slice(0, index + 1).join("/");
  clearSelection();
  loadDir();
}

function onUploadFile(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files?.length) uploadQueue.value = classifyUploadItems(Array.from(target.files));
}

async function doUpload() {
  const queued = activeUploadItems.value;
  if (!queued.length) { uploadMsg.value = t("files.selectFileFirst"); uploadErr.value = true; return; }
  uploadBusy.value = true;
  uploadErr.value = false;
  uploadDoneCount.value = 0;
  uploadFailedNames.value = [];
  uploadProgressList.value = uploadQueue.value.map(() => 0);
  const total = queued.length;
  // uploads push real bytes through this browser; pause the
  // background metadata pool for the duration so it doesn't compete for
  // bandwidth.
  try {
    await mapConcurrent(queued.map((item) => ({ item, index: uploadQueue.value.indexOf(item) })), UPLOAD_CONCURRENCY, async ({ item, index }) => {
      const file = item.file;
      uploadMsg.value = t("files.uploadingFile", { current: uploadDoneCount.value + uploadFailedNames.value.length + 1, total });
      try {
        const raw = await uploadFile(file, uploadTarget.value, uploadPathFor(item), {
          profiles: item.kind === "audio" || item.kind === "variant" ? preTranscodeProfiles.value : undefined,
          onProgress: (loaded, size) => {
            uploadProgressList.value[index] = size > 0 ? Math.round((loaded / size) * 100) : 0;
          },
        });
        uploadProgressList.value[index] = 100;
        uploadDoneCount.value++;
        // When "parse metadata on upload" is on, parse the file's
        // tags in-browser and submit them so the song relinks to the right
        // album/artist immediately, no worker-pool round-trip needed.
        if (uploadParseMetadata.value && (item.kind === "audio" || item.kind === "variant")) {
          try {
            const resp = JSON.parse(raw) as { id?: string };
            if (resp.id) {
              const tags = await extractMetadata(file);
              await submitMetadata(resp.id, tags as Record<string, string | number>);
            }
          } catch (parseErr) {
            console.error(`[upload] metadata parse/submit failed for ${file.name}:`, parseErr);
            // Not fatal — the file already lives in R2/D1; a manual scan
            // will pick it up later.
          }
        }
      } catch (e) {
        uploadProgressList.value[index] = -1;
        uploadFailedNames.value.push(file.name);
        // Surface the backend's error message (e.g. demo upload cap, R2
        // storage limit) so the user knows why this specific file failed.
        const reason = e instanceof Error ? e.message : String(e);
        showToast(`${t("files.uploadFailed")}: ${reason}`, "error");
      }
    });
    if (uploadFailedNames.value.length === 0) {
      showToast(t("files.uploadDone", { n: total }));
      uploadMsg.value = "";
    } else {
      uploadMsg.value = t("files.uploadPartialFail", { done: uploadDoneCount.value, failed: uploadFailedNames.value.length });
      uploadErr.value = true;
      showToast(uploadMsg.value, "error");
    }
    loadDir();
  } finally {
    uploadBusy.value = false;
    uploadQueue.value = [];
    uploadProgressList.value = [];
    if (uploadInput.value) uploadInput.value.value = "";
    if (syncUploadInput.value) syncUploadInput.value.value = "";
  }
}

function openCrossModal(f: FileEntry) {
  crossCopyModal.value = { files: [f] };
  crossCopyDestSource.value = "r2";
  crossCopyDestPath.value = path.value;
  crossCopyQueue.value = [];
}
function openCrossModalBatch() {
  if (hasDirSelection.value) return; // cross-copy is file-only — button is disabled too
  const targets = selectedFileEntries.value;
  if (targets.length === 0) return;
  crossCopyModal.value = { files: targets };
  crossCopyDestSource.value = "r2";
  crossCopyDestPath.value = path.value;
  crossCopyQueue.value = [];
}
function resetCrossModal() {
  crossCopyModal.value = null;
  crossCopyQueue.value = [];
}
// Backdrop / Escape / Cancel only — the busy guard must not reach the success
// path, which closes while the batch flag is still set.
function closeCrossModal() {
  if (crossCopyBusy.value) return; // don't yank the modal away mid-batch
  resetCrossModal();
}
function toggleCrossSelect(f: FileEntry) {
  if (selectedFiles.value.has(f.uri)) selectedFiles.value.delete(f.uri);
  else selectedFiles.value.add(f.uri);
}
function joinPath(dir: string, name: string): string {
  const d = dir.replace(/\/+$/, "");
  return d ? `${d}/${name}` : name;
}

async function confirmCrossOp() {
  if (!crossCopyModal.value) return;
  const targets = crossCopyModal.value.files;
  crossCopyBusy.value = true;
  crossCopyQueue.value = targets.map((file) => ({ file, status: "pending" }));
  try {
    await mapConcurrent(crossCopyQueue.value, CROSS_COPY_CONCURRENCY, async (item) => {
      item.status = "copying";
      try {
        await crossCopy(item.file.uri, crossCopyDestSource.value, joinPath(crossCopyDestPath.value, item.file.name));
        item.status = "done";
      } catch (e) {
        item.status = "failed";
        item.error = e instanceof Error ? e.message : String(e);
      }
    });
    const failed = crossCopyQueue.value.filter((i) => i.status === "failed").length;
    if (failed === 0) {
      showToast(targets.length > 1 ? t("files.crossCopiedBatch", { n: targets.length }) : t("files.crossCopied"));
      clearSelection();
      resetCrossModal();
    } else {
      showToast(t("files.crossCopyPartialFail", { done: targets.length - failed, failed }), "error");
    }
    loadDir();
  } finally {
    crossCopyBusy.value = false;
  }
}

async function runTagScan() {
  if (scanning.value) return;
  scanning.value = true;
  scanProcessed.value = 0;
  scanRemaining.value = null;
  let totalTagged = 0;
  try {
    for (;;) {
      const text = await tagFetch("read", { batch: "4" });
      const data = JSON.parse(text);
      if (data.ok !== true) { showToast(t("files.scanFailed"), "error"); return; }
      scanProcessed.value += data.processed || 0;
      totalTagged += data.tagged || 0;
      scanRemaining.value = data.remaining ?? 0;
      if (!data.remaining) break;
    }
    showToast(t("files.scanDone", { tagged: totalTagged }));
  } catch {
    showToast(t("files.scanFailed"), "error");
  } finally {
    scanning.value = false;
    scanRemaining.value = null;
  }
}


// The input lives inside a v-for, where a template ref collects into an array;
// only one row is ever in rename mode, so query for the live one instead.
// Files open with the suffix left out of the selection so typing a new name
// doesn't silently drop the extension.
async function focusRenameInput(keepSuffix: boolean) {
  await nextTick();
  const el = document.querySelector<HTMLInputElement>(".entry-list .rename-input");
  if (!el) return;
  el.focus();
  const dot = keepSuffix ? el.value.lastIndexOf(".") : -1;
  if (dot > 0) el.setSelectionRange(0, dot);
  else el.select();
}

function startRename(f: FileEntry) {
  renamingDir.value = null;
  renamingFile.value = f.name;
  renameInput.value = f.name;
  focusRenameInput(true);
}

function startRenameDir(d: DirEntry) {
  renamingFile.value = null;
  renamingDir.value = d.name;
  renameInput.value = d.name;
  focusRenameInput(false);
}

function cancelRename() {
  renamingFile.value = null;
  renamingDir.value = null;
  renameInput.value = "";
}

async function confirmRename(f: FileEntry) {
  const newName = renameInput.value.trim();
  if (!newName || newName === f.name) { cancelRename(); return; }
  const fromKey = r2Key(f);
  const dir = path.value ? path.value + "/" : "";
  const toKey = dir + newName;
  opBusy.value = true;
  try {
    const res = await storagePost("files/move", { key: fromKey, dest: toKey });
    if (!JSON.parse(res).ok) throw new Error();
    showToast(t("files.renamed"));
    loadDir();
  } catch { showToast(t("files.opFailed"), "error"); }
  finally { opBusy.value = false; cancelRename(); }
}

// Folder rename rides on files/moveFolder: a same-parent destination is a
// plain rename as far as the backend is concerned (it only refuses moving a
// folder into itself or a descendant), and it rewrites storage_uri along the
// way, so no dedicated endpoint is needed.
async function confirmRenameDir(d: DirEntry) {
  const newName = renameInput.value.trim();
  if (!newName || newName === d.name) { cancelRename(); return; }
  if (/[\\/]/.test(newName)) { showToast(t("files.folderNameInvalid"), "error"); return; }
  opBusy.value = true;
  try {
    const res = await storagePost("files/moveFolder", {
      path: joinPath(path.value, d.name),
      dest: joinPath(path.value, newName),
    });
    if (!JSON.parse(res).ok) throw new Error();
    showToast(t("files.folderRenamed"));
    loadDir();
  } catch { showToast(t("files.opFailed"), "error"); }
  finally { opBusy.value = false; cancelRename(); }
}

function openMoveModal(f: FileEntry, mode: "move" | "copy") {
  opModal.value = { files: [f], dirs: [], mode, base: path.value };
  opQueue.value = [];
  initDestTree();
}

function openDirMoveModal(d: DirEntry) {
  opModal.value = { files: [], dirs: [d.name], mode: "move", base: path.value };
  opQueue.value = [];
  initDestTree();
}

function openBatchMoveModal() {
  const fileTargets = selectedFileEntries.value;
  const dirTargets = selectedDirEntries.value.map((d) => d.name);
  if (!fileTargets.length && !dirTargets.length) return;
  opModal.value = { files: fileTargets, dirs: dirTargets, mode: "move", base: path.value };
  opQueue.value = [];
  initDestTree();
}

function resetOpModal() {
  opModal.value = null;
  opQueue.value = [];
  destTreeRoot.value = null;
  treeNewFolderName.value = "";
}
// Backdrop / Escape / Cancel only — see resetCrossModal above.
function closeOpModal() {
  if (opBusy.value) return;
  resetOpModal();
}

// Returns null on failure so callers can decide whether to toast — the
// prefetch in initDestTree issues several of these at once and only wants one
// message however many of them fail.
async function fetchDestDirs(p: string): Promise<DestNode[] | null> {
  try {
    const text = await storageFetch("files/list", { source: currentSource.value, path: p });
    const data = JSON.parse(text);
    if (data.ok !== true) throw new Error(data.error || "list failed");
    return (data.dirs || [])
      .slice()
      .sort((a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name))
      .map((d: DirEntry): DestNode => ({ name: d.name, path: joinPath(p, d.name), children: null, expanded: false, loading: false }));
  } catch {
    return null;
  }
}

async function loadDestChildren(node: DestNode) {
  node.loading = true;
  try {
    const children = await fetchDestDirs(node.path);
    if (children === null) {
      node.children = node.children || [];
      showToast(t("files.treeLoadFailed"), "error");
      return;
    }
    node.children = children;
  } finally {
    node.loading = false;
  }
}

async function toggleDestNode(node: DestNode) {
  if (!node.expanded && node.children === null) await loadDestChildren(node);
  node.expanded = !node.expanded;
}

async function initDestTree() {
  const root: DestNode = { name: "", path: "", children: null, expanded: true, loading: false };
  destTreeRoot.value = root;
  opDestSelected.value = path.value;
  treeNewFolderName.value = "";
  // Walk the ref's reactive proxy, not the object literal handed to it:
  // writes to the raw object reach the same data but skip the proxy, so the
  // fetched children never reached the template and the picker stayed stuck
  // on a lone root row.
  let node = destTreeRoot.value;
  // Every level down to the current directory is known before the first
  // request, so fetch the whole chain at once. Walking it a level at a time
  // cost one round trip per path segment before the folder the user is
  // standing in — the one they most likely want — showed up at all.
  const segs = path.value ? path.value.split("/") : [];
  const levels = ["", ...segs.map((_, i) => segs.slice(0, i + 1).join("/"))];
  node.loading = true;
  const listings = await Promise.all(levels.map(fetchDestDirs));
  node.loading = false;
  if (listings.some((l) => l === null)) showToast(t("files.treeLoadFailed"), "error");
  for (let i = 0; i < levels.length; i++) {
    const children = listings[i];
    if (children === null) break;
    node.children = children;
    node.expanded = true;
    const nextPath = levels[i + 1];
    if (nextPath === undefined) break;
    const next = node.children.find((c) => c.path === nextPath);
    if (!next) break;
    node = next;
  }
}

const destTreeRows = computed(() => {
  const rows: Array<{ node: DestNode; depth: number }> = [];
  const walk = (node: DestNode, depth: number) => {
    rows.push({ node, depth });
    if (node.expanded && node.children) for (const child of node.children) walk(child, depth + 1);
  };
  if (destTreeRoot.value) walk(destTreeRoot.value, 0);
  return rows;
});

function findDestNode(node: DestNode | null, p: string): DestNode | null {
  if (!node) return null;
  if (node.path === p) return node;
  for (const child of node.children || []) {
    if (p === child.path || p.startsWith(`${child.path}/`)) return findDestNode(child, p);
  }
  return null;
}

async function createFolderInTree() {
  const name = treeNewFolderName.value.trim();
  if (!name || /[\\/]/.test(name)) { showToast(t("files.folderNameInvalid"), "error"); return; }
  treeNewFolderBusy.value = true;
  try {
    const parentPath = opDestSelected.value;
    const res = await storagePost("files/mkdir", { source: currentSource.value, path: joinPath(parentPath, name) });
    if (!JSON.parse(res).ok) throw new Error();
    treeNewFolderName.value = "";
    const parent = findDestNode(destTreeRoot.value, parentPath);
    if (parent) {
      await loadDestChildren(parent);
      parent.expanded = true;
    }
    opDestSelected.value = joinPath(parentPath, name);
  } catch {
    showToast(t("files.folderCreateFailed"), "error");
  } finally {
    treeNewFolderBusy.value = false;
  }
}

const destInsideSelectedDir = computed(() => {
  if (!opModal.value) return false;
  const { dirs: dirNames, base } = opModal.value;
  const dest = opDestSelected.value;
  return dirNames.some((name) => {
    const src = joinPath(base, name);
    return dest === src || dest.startsWith(`${src}/`);
  });
});

const opTargetCount = computed(() => (opModal.value ? opModal.value.files.length + opModal.value.dirs.length : 0));
const opTitleName = computed(() => {
  if (!opModal.value || opTargetCount.value !== 1) return "";
  return opModal.value.dirs[0] ?? opModal.value.files[0]?.name ?? "";
});

async function confirmOp() {
  if (!opModal.value || destInsideSelectedDir.value) return;
  const { files: fileTargets, dirs: dirTargets, mode, base } = opModal.value;
  const destDir = opDestSelected.value.replace(/\/$/, "");
  opBusy.value = true;
  opQueue.value = [
    ...dirTargets.map((name) => ({ kind: "dir" as const, name, key: joinPath(base, name), status: "pending" as const })),
    ...fileTargets.map((file) => ({ kind: "file" as const, name: file.name, key: r2Key(file), status: "pending" as const })),
  ];
  try {
    const endpoint = mode === "move" ? "files/move" : "files/copy";
    await mapConcurrent(opQueue.value, OP_CONCURRENCY, async (item) => {
      item.status = "running";
      try {
        const dest = joinPath(destDir, item.name);
        // Folders only ever reach here in move mode (no batch copy UI).
        const res = item.kind === "dir"
          ? await storagePost("files/moveFolder", { path: item.key, dest })
          : await storagePost(endpoint, { key: item.key, dest });
        if (!JSON.parse(res).ok) throw new Error();
        item.status = "done";
      } catch (e) {
        item.status = "failed";
        item.error = e instanceof Error ? e.message : String(e);
      }
    });
    const failed = opQueue.value.filter((i) => i.status === "failed").length;
    const total = opQueue.value.length;
    const verb = mode === "move" ? t("files.moved") : t("files.copied");
    if (failed === 0) {
      showToast(total > 1 ? t("files.batchOpDone", { n: total, verb }) : verb);
      clearSelection();
      resetOpModal();
    } else {
      showToast(t("files.batchOpPartialFail", { done: total - failed, failed }), "error");
    }
    loadDir();
  } finally {
    opBusy.value = false;
  }
}

function openDeleteConfirm(f: FileEntry) {
  deleteConfirmModal.value = { files: [f], dirs: [], base: path.value };
}
function openDirDeleteConfirm(d: DirEntry) {
  deleteConfirmModal.value = { files: [], dirs: [d.name], base: path.value };
}
function openBatchDeleteConfirm() {
  const fileTargets = selectedFileEntries.value;
  const dirTargets = selectedDirEntries.value.map((d) => d.name);
  if (!fileTargets.length && !dirTargets.length) return;
  deleteConfirmModal.value = { files: fileTargets, dirs: dirTargets, base: path.value };
}
function cancelDeleteConfirm() {
  if (opBusy.value) return;
  deleteConfirmModal.value = null;
}

const deleteConfirmText = computed(() => {
  if (!deleteConfirmModal.value) return "";
  const { files: f, dirs: d } = deleteConfirmModal.value;
  if (!d.length) {
    return f.length === 1
      ? t("files.deleteConfirm", { name: f[0].name })
      : t("files.deleteConfirmBatch", { n: f.length });
  }
  if (!f.length && d.length === 1) return t("files.deleteConfirmFolder", { name: d[0] });
  return t("files.deleteConfirmMixed", { files: f.length, dirs: d.length });
});

async function confirmDelete() {
  if (!deleteConfirmModal.value) return;
  const { files: fileTargets, dirs: dirTargets, base } = deleteConfirmModal.value;
  deleteConfirmModal.value = null;
  opBusy.value = true;
  const queue = [
    ...dirTargets.map((name) => ({ kind: "dir" as const, key: joinPath(base, name), error: undefined as string | undefined })),
    ...fileTargets.map((file) => ({ kind: "file" as const, key: r2Key(file), error: undefined as string | undefined })),
  ];
  try {
    await mapConcurrent(queue, OP_CONCURRENCY, async (item) => {
      try {
        // Folder deletes are recursive server-side (files/deleteFolder).
        const res = item.kind === "dir"
          ? await storagePost("files/deleteFolder", { path: item.key })
          : await storagePost("files/delete", { key: item.key });
        if (!JSON.parse(res).ok) throw new Error();
      } catch (e) {
        item.error = e instanceof Error ? e.message : String(e);
      }
    });
    const failed = queue.filter((i) => i.error).length;
    if (failed === 0) {
      showToast(queue.length > 1 ? t("files.batchOpDone", { n: queue.length, verb: t("files.deleted") }) : t("files.deleted"));
      clearSelection();
    } else {
      showToast(t("files.batchOpPartialFail", { done: queue.length - failed, failed }), "error");
    }
    loadDir();
  } finally {
    opBusy.value = false;
  }
}

function openNewFolderModal() {
  newFolderName.value = "";
  newFolderModal.value = true;
  // Same reason as the rename input: the autofocus attribute is only honoured
  // on the initial parse, never on a node Vue inserts later.
  nextTick(() => document.querySelector<HTMLInputElement>(".new-folder-input")?.focus());
}

function resetNewFolderModal() {
  newFolderModal.value = false;
  newFolderName.value = "";
}
// Backdrop / Escape / Cancel only — see resetCrossModal above.
function closeNewFolderModal() {
  if (newFolderBusy.value) return;
  resetNewFolderModal();
}

async function confirmNewFolder() {
  const name = newFolderName.value.trim();
  if (!name || /[\\/]/.test(name)) { showToast(t("files.folderNameInvalid"), "error"); return; }
  newFolderBusy.value = true;
  try {
    const res = await storagePost("files/mkdir", { source: currentSource.value, path: joinPath(path.value, name) });
    if (!JSON.parse(res).ok) throw new Error();
    showToast(t("files.folderCreated"));
    resetNewFolderModal();
    loadDir();
  } catch { showToast(t("files.folderCreateFailed"), "error"); }
  finally { newFolderBusy.value = false; }
}

const editorOpen = ref(false);
const editorMode = ref<"single" | "batch">("single");
const editTargetId = ref<string | null>(null); // single mode
const editTargetIds = ref<string[]>([]); // batch mode
const editInitial = ref<Record<string, string | number>>({});
const editCoverArt = ref<string>("");
const editBusy = ref(false);
const editMsg = ref("");
const editErr = ref(false);
const editExistingCoverUrl = computed(() => editCoverArt.value ? coverArtUrl(editCoverArt.value, 200) : undefined);

const canEditTags = computed(() => hasPerm("edit_tags"));
const isAudio = (name: string) => /\.(mp3|flac|wav|ogg|opus|m4a|aac)$/i.test(name);

async function lookupSongByFilename(f: FileEntry, songCount = 5): Promise<Record<string, string> | null> {
  const stem = f.name.replace(/\.[^.]+$/, "");
  const searchStem = normalizeForMatch(stem);
  const xml = await authFetch("search3", { query: searchStem, songCount: String(songCount), artistCount: "0", albumCount: "0" });
  const songs = parseXmlAttrs(xml, "song");
  if (!songs.length) return null;
  return songs.find((s) => normalizeForMatch(s.title) === searchStem) || songs[0];
}

async function openTagEditor(f: FileEntry) {
  try {
    const hit = await lookupSongByFilename(f, 20);
    if (!hit) {
      showToast(t("files.editLookupFailed"), "error");
      return;
    }
    editorMode.value = "single";
    editTargetId.value = hit.id || null;
    editInitial.value = {
      title: hit.title || "",
      artist: hit.artist || "",
      album: hit.album || "",
      albumArtist: hit.albumArtist || "",
      genre: hit.genre || "",
      year: hit.year || "",
      track: hit.track || "",
      disc: hit.discNumber || "",
    };
    editCoverArt.value = hit.coverArt || "";
    editMsg.value = ""; editErr.value = false;
    editorOpen.value = true;
  } catch {
    showToast(t("files.editLookupFailed"), "error");
  }
}

async function openBatchTagEditor() {
  if (hasDirSelection.value) return; // tag-edit is file-only — button is disabled too
  const targets = selectedFileEntries.value;
  const ids: string[] = [];
  for (const f of targets) {
    try {
      const hit = await lookupSongByFilename(f);
      if (hit?.id) ids.push(hit.id);
    } catch {
      // skip — partial coverage is still useful
    }
  }
  if (!ids.length) {
    showToast(t("files.editLookupFailed"), "error");
    return;
  }
  if (ids.length < targets.length) {
    showToast(t("files.editBatchPartial", { n: targets.length - ids.length }), "success");
  }
  editorMode.value = "batch";
  editTargetIds.value = ids;
  editInitial.value = {};
  editMsg.value = ""; editErr.value = false;
  editorOpen.value = true;
}

function closeTagEditor() { editorOpen.value = false; }

function scrapeQueryFromForm(form: Record<string, string>): string {
  const t1 = (form.title || "").trim();
  const a1 = (form.artist || "").trim();
  if (t1 || a1) return [t1, a1].filter(Boolean).join(" ");
  const init = editInitial.value;
  return [init.title, init.artist].filter(Boolean).join(" ");
}

function applyScrapeResult(
  form: Record<string, string>,
  applyFlags: Record<string, boolean>,
  r: ScrapeResult,
) {
  if (r.title) form.title = r.title;
  if (r.artist) form.artist = r.artist;
  if (r.albumArtist) form.albumArtist = r.albumArtist;
  if (r.album) form.album = r.album;
  if (r.year) form.year = String(r.year);
  if (r.lyrics) form.lyrics = r.lyrics;
  if (r.title) applyFlags.title = true;
  if (r.artist) applyFlags.artist = true;
  if (r.albumArtist) applyFlags.albumArtist = true;
  if (r.album) applyFlags.album = true;
  if (r.year) applyFlags.year = true;
  if (r.lyrics) applyFlags.lyrics = true;
}

const DEFAULT_TIDY_TEMPLATE = "{albumArtist}/{album}/{track:02d} - {title}";
const tidyOpen = ref(false);
const tidyTemplate = ref(DEFAULT_TIDY_TEMPLATE);
const tidyDryRun = ref(true);
const tidyBusy = ref(false);
const tidyMsg = ref("");
const tidyErr = ref(false);
const tidyPlanned = ref<Array<{ id: string; instanceId: string; from: string; to: string; skipped?: string }>>([]);
const tidyApplied = ref<Array<{ id: string; instanceId: string; ok: boolean; error?: string }>>([]);
const tidyTargetIds = ref<string[]>([]);

const canTidy = computed(() => hasPerm("manage_files"));

async function openTidyFolder() {
  // Resolve master_ids for every audio file in the current dir, the same way
  // we resolve them for the single-track tag editor (search3 on the filename
  // stem). Anything that doesn't resolve is silently dropped — the user has
  // already been told to run a scan first via the editor's affordance.
  const ids: string[] = [];
  for (const f of files.value) {
    if (!isAudio(f.name)) continue;
    try {
      const hit = await lookupSongByFilename(f);
      if (hit?.id) ids.push(hit.id);
    } catch {
      // skip — partial coverage is still useful
    }
  }
  if (!ids.length) {
    showToast(t("files.tidyEmpty"), "error");
    return;
  }
  tidyTargetIds.value = ids;
  tidyTemplate.value = DEFAULT_TIDY_TEMPLATE;
  tidyDryRun.value = true;
  tidyPlanned.value = [];
  tidyApplied.value = [];
  tidyMsg.value = "";
  tidyErr.value = false;
  tidyOpen.value = true;
}

async function runTidyFolder() {
  if (!tidyTargetIds.value.length || !tidyTemplate.value.trim()) return;
  tidyBusy.value = true; tidyMsg.value = ""; tidyErr.value = false;
  try {
    const res = await tidyFolder(tidyTargetIds.value, tidyTemplate.value, {
      dryRun: tidyDryRun.value,
      source: currentSource.value === "r2" ? "r2" : undefined,
    });
    if (!res.ok) {
      tidyErr.value = true;
      tidyMsg.value = res.error || t("files.tidyFailed");
      return;
    }
    tidyPlanned.value = res.planned || [];
    tidyApplied.value = res.applied || [];
    if (!tidyDryRun.value) {
      const ok = (res.applied || []).filter((a) => a.ok).length;
      tidyMsg.value = t("files.tidyDone", { ok, failed: res.failed ?? 0 });
      loadDir();
    }
  } catch {
    tidyErr.value = true;
    tidyMsg.value = t("files.tidyFailed");
  } finally {
    tidyBusy.value = false;
  }
}

function closeTidyFolder() { tidyOpen.value = false; }

async function onTagEditorSubmit(patch: Record<string, string | number>, cover?: { data: string; mime: string }) {
  if (!Object.keys(patch).length && !cover) return;
  editBusy.value = true; editMsg.value = ""; editErr.value = false;
  try {
    if (editorMode.value === "batch") {
      if (!editTargetIds.value.length) return;
      const res = await batchWriteTags(editTargetIds.value, patch, cover);
      if (!res.ok) {
        editErr.value = true;
        editMsg.value = res.error || t("tagEditor.batchFailed");
      } else {
        editMsg.value = t("tagEditor.batchSaved", { succeeded: res.succeeded ?? 0, failed: res.failed ?? 0 });
        clearSelection();
        setTimeout(() => { editorOpen.value = false; }, 1500);
      }
    } else {
      if (!editTargetId.value) return;
      const res = await writeTags(editTargetId.value, patch, cover);
      if (!res.ok) {
        editErr.value = true;
        editMsg.value = res.error || t("library.editFailed");
      } else {
        const written = (res.files || []).filter((x) => x.written).length;
        editMsg.value = t("library.editSaved", { written, total: (res.files || []).length });
        // brief delay so the user reads it, then close
        setTimeout(() => { editorOpen.value = false; }, 1200);
      }
    }
  } catch {
    editErr.value = true;
    editMsg.value = editorMode.value === "batch" ? t("tagEditor.batchFailed") : t("library.editFailed");
  } finally {
    // finally (not just after try/catch) so the early `return` above for an
    // empty batch target list still cleans these up.
    editBusy.value = false;
  }
}

// ——— Context menu ———
// Right-click on desktop, long-press on touch. The inline .op-btn strip stays
// the primary affordance for files; the menu is the only home for the
// folder-level operations (rename / move / delete).
type CtxTarget =
  | { kind: "file"; file: FileEntry }
  | { kind: "dir"; dir: DirEntry }
  | { kind: "blank" };

const ctxMenu = ref<{ x: number; y: number; target: CtxTarget } | null>(null);
const ctxMenuEl = ref<HTMLElement | null>(null);
// Kept hidden until the post-render clamp has run so a menu opened near a
// viewport edge doesn't visibly jump from the click point to its final spot.
const ctxPlaced = ref(false);

const ctxFile = computed(() => (ctxMenu.value?.target.kind === "file" ? ctxMenu.value.target.file : null));
const ctxDir = computed(() => (ctxMenu.value?.target.kind === "dir" ? ctxMenu.value.target.dir : null));

// A right-click inside a multi-selection acts on the whole selection; on a row
// outside it the menu targets that row alone and leaves the checkboxes alone.
const ctxOnSelection = computed(() => {
  const target = ctxMenu.value?.target;
  if (!target || selectedTotal.value < 2) return false;
  if (target.kind === "file") return selectedFiles.value.has(target.file.uri);
  if (target.kind === "dir") return selectedDirs.value.has(target.dir.name);
  return false;
});

const ctxStyle = computed<CSSProperties>(() => ({
  left: `${ctxMenu.value?.x ?? 0}px`,
  top: `${ctxMenu.value?.y ?? 0}px`,
  visibility: ctxPlaced.value ? "visible" : "hidden",
}));

async function openContextMenu(x: number, y: number, target: CtxTarget) {
  ctxPlaced.value = false;
  ctxMenu.value = { x, y, target };
  // Re-adding an identical listener is a no-op, so reopening while a menu is
  // already up doesn't stack these.
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("contextmenu", onDocumentContextMenu);
  document.addEventListener("keydown", onCtxKeydown);
  window.addEventListener("resize", closeContextMenu);
  window.addEventListener("scroll", closeContextMenu, true);
  await nextTick();
  const el = ctxMenuEl.value;
  const menu = ctxMenu.value;
  if (el && menu) {
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    menu.x = Math.max(margin, Math.min(x, window.innerWidth - width - margin));
    menu.y = Math.max(margin, Math.min(y, window.innerHeight - height - margin));
  }
  ctxPlaced.value = true;
  el?.querySelector<HTMLButtonElement>(".ctx-item")?.focus({ preventScroll: true });
}

function closeContextMenu() {
  ctxMenu.value = null;
  ctxPlaced.value = false;
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("contextmenu", onDocumentContextMenu);
  document.removeEventListener("keydown", onCtxKeydown);
  window.removeEventListener("resize", closeContextMenu);
  window.removeEventListener("scroll", closeContextMenu, true);
}

// Entry rows stop their own contextmenu event, so anything reaching the
// document is a right-click somewhere else on the page: let the browser show
// its native menu there and drop ours.
function onDocumentContextMenu(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".ctx-menu")) closeContextMenu();
}

function onDocumentClick(e: MouseEvent) {
  // Touch browsers fire a synthetic click after a long press; without this
  // window it would close the menu the same moment the press opened it.
  if (Date.now() - longPressAt < CLICK_AFTER_PRESS_MS) return;
  if (!(e.target as HTMLElement).closest(".ctx-menu")) closeContextMenu();
}

function onCtxKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") { closeContextMenu(); return; }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = Array.from(ctxMenuEl.value?.querySelectorAll<HTMLButtonElement>(".ctx-item:not([disabled])") ?? []);
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === "ArrowDown"
    ? (at + 1) % items.length
    : (at <= 0 ? items.length - 1 : at - 1);
  items[next]?.focus({ preventScroll: true });
}

function onRowContextMenu(e: MouseEvent, target: CtxTarget) {
  e.preventDefault();
  e.stopPropagation();
  openContextMenu(e.clientX, e.clientY, target);
}

function ctxTargetKey(target: CtxTarget): string {
  if (target.kind === "file") return `f:${target.file.uri}`;
  if (target.kind === "dir") return `d:${target.dir.name}`;
  return "blank";
}

// The row's ⋯ button, which replaced the strip of per-action buttons. Opens
// the same menu anchored under the trigger; the viewport clamp pulls it back
// in from the right edge. .stop keeps this click away from the
// outside-click listener, so a second press toggles instead of reopening.
function openRowMenu(e: MouseEvent, target: CtxTarget) {
  e.stopPropagation();
  if (ctxMenu.value && ctxTargetKey(ctxMenu.value.target) === ctxTargetKey(target)) {
    closeContextMenu();
    return;
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu(rect.right, rect.bottom + 4, target);
}

// Menu items read ctxFile/ctxDir, and closing clears them — so the action has
// to run before the dismiss, not after.
function ctxRun(action: () => void) {
  try { action(); } finally { closeContextMenu(); }
}

// Touch long-press stands in for the right button, the same 500 ms / 10 px
// thresholds a desktop file manager uses.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;
const CLICK_AFTER_PRESS_MS = 700;
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressX = 0;
let pressY = 0;
let longPressAt = 0;

function cancelLongPress() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
}

function onRowTouchStart(e: TouchEvent, target: CtxTarget) {
  cancelLongPress();
  if (e.touches.length !== 1) return;
  pressX = e.touches[0].clientX;
  pressY = e.touches[0].clientY;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressAt = Date.now();
    openContextMenu(pressX, pressY, target);
  }, LONG_PRESS_MS);
}

function onRowTouchMove(e: TouchEvent) {
  const touch = e.touches[0];
  if (!touch) return;
  if (Math.abs(touch.clientX - pressX) > LONG_PRESS_MOVE_PX || Math.abs(touch.clientY - pressY) > LONG_PRESS_MOVE_PX) {
    cancelLongPress();
  }
}

function onDirRowClick(d: DirEntry) {
  if (renamingDir.value === d.name) return;
  if (Date.now() - longPressAt < CLICK_AFTER_PRESS_MS) return;
  enterDir(d.name);
}

onMounted(async () => {
  await loadSources();
  await loadDir();
  await loadPending();
});

onBeforeUnmount(() => {
  cancelLongPress();
  closeContextMenu();
});

</script>

<template>
  <div class="files-page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("files.label") }}</div>
        <h1 class="page-title">{{ t("files.title") }}</h1>
      </div>
      <div class="page-actions">
        <span v-if="scanning" class="scan-progress">{{ t("files.scanProgress", { processed: scanProcessed, remaining: scanRemaining ?? "…" }) }}</span>
        <span v-if="pendingCount > 0" class="pending-badge" :title="t('files.pendingBadgeTitle')">
          {{ t("files.pendingBadge", { n: pendingCount }) }}
        </span>
        <button v-if="canScan" class="btn-secondary" :disabled="scanning" @click="runTagScan">{{ t("files.scanTags") }}</button>
        <button v-if="canTidy" class="btn-secondary" :disabled="scanning || tidyBusy" @click="openTidyFolder">{{ t("files.tidy") }}</button>
        <button v-if="canUpload" class="btn-primary" @click="showUpload = !showUpload">{{ t("files.upload") }}</button>
      </div>
    </div>

    <!-- Work-queue HUD lived here until task moved entirely to Tools.vue's
         「WORKER 预解析」panel. The /files page no longer manages or surfaces
         work_queue state, only the existing 「待解析」badge above (pendingCount)
         so the user still knows when files are awaiting parse. -->

    <div class="source-bar">
      <span class="source-bar-label">{{ t("files.source") }}</span>
      <button :class="['source-tab', { active: currentSource === 'r2' }]" @click="selectSource('r2')">R2</button>
      <button
        v-for="s in sources" :key="s.id"
        :class="['source-tab', { active: currentSource === s.id }]"
        @click="selectSource(s.id)"
      >{{ s.name || `${s.type.toUpperCase()} · ${shortUrl(s.baseUrl)}` }}</button>
    </div>

    <div v-if="showUpload && canUpload" class="card upload-panel">
      <div class="card-header"><span class="card-title">{{ t("files.uploadFile") }}</span></div>
      <div class="form-row">
        <div class="form-group" style="flex:1">
          <label class="form-label">{{ t("files.target") }}</label>
          <div class="upload-dest">{{ sourceLabel(currentSource) }} : /{{ path }}</div>
        </div>
        <div class="form-group" style="flex:2">
          <label class="form-label">{{ t("files.file") }}</label>
          <div class="upload-file-row">
            <input ref="uploadInput" type="file" multiple :accept="uploadAccept" class="form-input" @change="onUploadFile" />
            <select v-if="canSelectAllFiles" v-model="uploadAcceptMode" class="form-input upload-type-select" :aria-label="t('files.fileTypeFilter')">
              <option value="music">{{ t("files.fileTypeMusic") }}</option>
              <option value="all">{{ t("files.fileTypeAll") }}</option>
            </select>
          </div>
        </div>
        <button class="btn-primary" :disabled="!activeUploadItems.length || uploadBusy" @click="doUpload">
          {{ uploadBusy ? t("files.uploading") : t("files.uploadBtn") }}
        </button>
      </div>
      <div class="sync-upload-row">
        <input ref="syncUploadInput" type="file" multiple webkitdirectory :accept="uploadAccept" class="sync-upload-input" @change="onUploadFile" />
        <button type="button" class="btn-secondary" :disabled="uploadBusy" @click="syncUploadInput?.click()">{{ t("files.syncUpload") }}</button>
        <span class="upload-options-hint">{{ t("files.syncUploadHint") }}</span>
      </div>
      <div class="upload-options-row">
        <label class="toggle" :title="t('files.parseMetadataHint')">
          <input type="checkbox" v-model="uploadParseMetadata" />
          <span class="toggle-slider"></span>
        </label>
        <span class="upload-options-label">{{ t("files.parseMetadata") }}</span>
        <span class="upload-options-hint">{{ t("files.parseMetadataHint") }}</span>
      </div>
      <div class="pre-transcode-block">
        <button type="button" class="pre-transcode-toggle" :aria-expanded="showPreTranscode" @click="showPreTranscode = !showPreTranscode">
          <span>{{ t("files.preTranscode.title") }}</span>
          <span class="pre-transcode-caret">{{ showPreTranscode ? '−' : '+' }}</span>
        </button>
        <div v-show="showPreTranscode" class="pre-transcode-body">
          <p class="upload-options-hint">{{ t("files.preTranscode.hint") }}</p>
          <div class="pre-transcode-profiles">
            <label v-for="p in PRE_TRANSCODE_PROFILES" :key="p.id" class="pre-transcode-pill">
              <input type="checkbox" :value="p.id" v-model="preTranscodeProfiles" />
              <span>{{ p.label }}</span>
            </label>
          </div>
        </div>
      </div>
      <div class="sync-options-row">
        <label class="toggle"><input type="checkbox" v-model="includeLyrics" /><span class="toggle-slider"></span></label>
        <span class="upload-options-label">{{ t("files.includeLyrics") }}</span>
        <label class="toggle"><input type="checkbox" v-model="includeVariants" /><span class="toggle-slider"></span></label>
        <span class="upload-options-label">{{ t("files.includeVariants") }}</span>
      </div>
      <div class="openyyy-guide">
        <div><strong>{{ t("files.openYYY.title") }}</strong> {{ t("files.openYYY.hint") }}</div>
        <button type="button" class="btn-secondary" @click="openOpenYYY">{{ t("files.openYYY.open") }}</button>
      </div>
      <!-- Upload queue list with per-file progress bars -->
      <div v-if="uploadQueue.length || uploadBusy" class="upload-queue">
        <div class="mono-label upload-queue-header">{{ t("files.uploadQueue") }}</div>
        <div v-for="(item, i) in uploadQueue" :key="i" class="upload-queue-item" :class="{ excluded: !activeUploadItems.includes(item) }">
          <span class="upload-queue-name">{{ item.file.name }}</span>
          <span class="upload-kind">{{ uploadKindLabel(item.kind) }}</span>
          <span v-if="item.kind === 'lyrics' || item.kind === 'variant'" class="upload-pair">{{ item.stem }}</span>
          <div class="upload-queue-bar">
            <div
              class="upload-queue-fill"
              :class="{ 'fill-error': uploadProgressList[i] === -1 }"
              :style="{ width: Math.max(0, uploadProgressList[i] ?? 0) + '%' }"
            ></div>
          </div>
          <span class="upload-queue-pct"><template v-if="item.kind === 'encrypted'">{{ t("files.convertFirst") }}</template><template v-else-if="uploadProgressList[i] === -1"><Icon name="cross" /></template><template v-else>{{ (uploadProgressList[i] ?? 0) + '%' }}</template></span>
        </div>
        <div v-if="uploadBusy" class="upload-queue-overall">{{ uploadMsg }}</div>
      </div>
      <p v-if="uploadMsg && !uploadBusy" :class="['upload-msg', { error: uploadErr }]">{{ uploadMsg }}</p>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <section class="file-browser">
      <div class="breadcrumb">
        <button class="crumb" :disabled="!path" @click="goCrumb(-1)">{{ t("files.root") }}</button>
        <template v-for="(seg, i) in crumbs" :key="i">
          <span class="crumb-sep">/</span>
          <button class="crumb" :disabled="i === crumbs.length - 1" @click="goCrumb(i)">{{ seg }}</button>
        </template>
        <span class="browser-stats">{{ t("files.stats", { dirs: dirs.length, files: files.length }) }}</span>
        <div class="file-sort-controls">
          <label>{{ t("files.sortBy") }}</label>
          <select v-model="fileSortKey" class="form-input" :aria-label="t('files.sortBy')">
            <option value="name">{{ t("files.sortName") }}</option>
            <option value="size">{{ t("files.sortSize") }}</option>
            <option value="type">{{ t("files.sortType") }}</option>
          </select>
          <button class="btn-secondary sort-direction" @click="fileSortDirection = fileSortDirection === 'asc' ? 'desc' : 'asc'">{{ fileSortDirection === "asc" ? t("files.sortAscending") : t("files.sortDescending") }}</button>
          <button class="btn-secondary sort-direction" @click="foldersFirst = !foldersFirst">{{ foldersFirst ? t("files.foldersFirst") : t("files.foldersLast") }}</button>
        </div>
        <button v-if="canUpload" class="btn-secondary btn-new-folder" @click="openNewFolderModal">
          {{ t("files.newFolder") }}
        </button>
      </div>

      <!-- Batch action bar for the checkbox selection. Move/Delete stay
           R2-only (mirrors the existing per-row move/copy/delete buttons,
           which only ever supported R2); tag-edit and cross-copy work across
           every source, matching their existing per-row buttons — but grey
           out while a folder is selected (they have no folder semantic).
           Move/Delete handle folders recursively via moveFolder/deleteFolder. -->
      <div v-if="canUpload && selectedTotal > 0" class="batch-actions-bar">
        <span class="batch-actions-count">{{ t("files.selectedCount", { n: selectedTotal }) }}</span>
        <button
          class="btn-secondary"
          :disabled="hasDirSelection"
          :title="hasDirSelection ? t('files.filesOnlyAction') : ''"
          @click="openBatchTagEditor"
        >{{ t("files.batchEditTags") }}</button>
        <button v-if="isR2" class="btn-secondary" @click="openBatchMoveModal">{{ t("files.batchMove") }}</button>
        <button v-if="isR2" class="btn-danger" @click="openBatchDeleteConfirm">{{ t("files.batchDelete") }}</button>
        <button
          class="btn-secondary"
          :disabled="hasDirSelection"
          :title="hasDirSelection ? t('files.filesOnlyAction') : ''"
          @click="openCrossModalBatch"
        >{{ t("files.crossCopyBtn") }}</button>
        <button class="btn-secondary batch-actions-clear" @click="clearSelection()">{{ t("files.clearSelection") }}</button>
      </div>

      <div class="entry-list" :class="{ 'folders-last': !foldersFirst }" @contextmenu="onRowContextMenu($event, { kind: 'blank' })">
        <div v-if="loading" class="list-loading">{{ t("common.loading") }}</div>
        <template v-else>
          <!-- Select-all header: checked when every dir+file is selected,
               indeterminate while only some are. -->
          <label v-if="canUpload && dirs.length + files.length > 0" class="entry-row select-all-row">
            <input
              type="checkbox"
              class="cross-select-box"
              :checked="allSelected"
              :indeterminate="selectedTotal > 0 && !allSelected"
              @change="toggleSelectAll"
            />
            <span class="select-all-label">{{ t("files.selectAll") }}</span>
            <span v-if="selectedTotal > 0" class="select-all-count">{{ t("files.selectedCount", { n: selectedTotal }) }}</span>
          </label>
          <div
            v-for="d in dirs"
            :key="`d-${d.name}`"
            class="entry-row dir-row"
            :class="{ 'row-renaming': renamingDir === d.name }"
            @click="onDirRowClick(d)"
            @contextmenu="onRowContextMenu($event, { kind: 'dir', dir: d })"
            @touchstart.passive="onRowTouchStart($event, { kind: 'dir', dir: d })"
            @touchmove.passive="onRowTouchMove"
            @touchend="cancelLongPress"
            @touchcancel="cancelLongPress"
          >
            <input
              v-if="canUpload"
              type="checkbox"
              class="cross-select-box"
              :checked="selectedDirs.has(d.name)"
              @click.stop="toggleDirSelect(d)"
            />
            <span class="entry-icon"><Icon name="folder" /></span>
            <!-- Rename: inline input, same treatment as the file rows -->
            <template v-if="renamingDir === d.name">
              <input
                v-model="renameInput"
                class="rename-input"
                @click.stop
                @keydown.enter="confirmRenameDir(d)"
                @keydown.escape="cancelRename"
              />
              <button class="op-btn op-confirm" :disabled="opBusy" @click.stop="confirmRenameDir(d)"><Icon name="check" /></button>
              <button class="op-btn op-cancel" @click.stop="cancelRename"><Icon name="cross" /></button>
            </template>
            <template v-else>
              <span class="entry-name">{{ d.name }}</span>
              <!-- Folders had no visible entry point at all before; same
                   trigger as the file rows. -->
              <button
                class="op-btn op-menu"
                :title="t('files.moreActions')"
                @click.stop="openRowMenu($event, { kind: 'dir', dir: d })"
              ><Icon name="dots" /></button>
            </template>
          </div>
          <div
            v-for="f in files"
            :key="`f-${f.name}`"
            class="entry-row file-row"
            :class="{ 'row-renaming': renamingFile === f.name }"
            @contextmenu="onRowContextMenu($event, { kind: 'file', file: f })"
            @touchstart.passive="onRowTouchStart($event, { kind: 'file', file: f })"
            @touchmove.passive="onRowTouchMove"
            @touchend="cancelLongPress"
            @touchcancel="cancelLongPress"
          >
            <input
              v-if="canUpload"
              type="checkbox"
              class="cross-select-box"
              :checked="selectedFiles.has(f.uri)"
              :title="t('files.crossCopySelectHint')"
              @click.stop="toggleCrossSelect(f)"
            />
            <span class="entry-icon file-icon"><Icon name="dot" /></span>
            <!-- Rename: inline input -->
            <template v-if="renamingFile === f.name">
              <input
                v-model="renameInput"
                class="rename-input"
                @keydown.enter="confirmRename(f)"
                @keydown.escape="cancelRename"
              />
              <button class="op-btn op-confirm" :disabled="opBusy" @click="confirmRename(f)"><Icon name="check" /></button>
              <button class="op-btn op-cancel" @click="cancelRename"><Icon name="cross" /></button>
            </template>
            <template v-else>
              <span class="entry-name">{{ f.name }}</span>
              <span class="entry-size">{{ formatSize(f.size) }}</span>
              <!-- Every per-row action lives in the menu now; the row keeps
                   one trigger instead of a strip of icon buttons. -->
              <button
                class="op-btn op-menu"
                :title="t('files.moreActions')"
                @click="openRowMenu($event, { kind: 'file', file: f })"
              ><Icon name="dots" /></button>
            </template>
          </div>
          <div v-if="!dirs.length && !files.length" class="empty-state">{{ t("files.empty") }}</div>
        </template>
      </div>
    </section>

    <!-- Move / Copy modal — generalized to N files (batch move); the
         free-text destination input became a lazy-loaded folder tree: expand
         with the caret (children fetched from files/list on demand), click a
         name to pick it as the destination. -->
    <div v-if="opModal" class="modal-backdrop" @click.self="closeOpModal">
      <div class="modal">
        <div class="modal-title">
          {{ opModal.mode === "move" ? t("files.moveTo") : t("files.copyTo") }}:
          {{ opTargetCount === 1 ? opTitleName : t("files.nItems", { n: opTargetCount }) }}
        </div>
        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.destFolder") }}</label>
          <div class="dest-tree">
            <div v-if="!destTreeRows.length" class="dest-tree-loading">{{ t("common.loading") }}</div>
            <div
              v-for="row in destTreeRows"
              :key="row.node.path || '/'"
              :class="['dest-tree-row', { selected: opDestSelected === row.node.path }]"
              :style="{ paddingLeft: (0.4 + row.depth * 1.1) + 'rem' }"
              @click="opDestSelected = row.node.path"
            >
              <button class="dest-tree-caret" :disabled="opBusy" @click.stop="toggleDestNode(row.node)">
                <Icon :name="row.node.loading ? 'refresh' : row.node.expanded ? 'down' : 'right'" />
              </button>
              <span class="dest-tree-name">{{ row.node.path === "" ? t("files.root") : row.node.name }}</span>
            </div>
          </div>
          <div class="dest-selected">{{ t("files.destPath") }}: /{{ opDestSelected }}</div>
          <p v-if="destInsideSelectedDir" class="dest-warning">{{ t("files.destInsideSelf") }}</p>
          <div class="dest-newfolder">
            <input
              v-model="treeNewFolderName"
              class="form-input"
              :placeholder="t('files.folderNamePlaceholder')"
              :disabled="opBusy || treeNewFolderBusy"
              @keydown.enter="createFolderInTree"
              @keydown.escape="closeOpModal"
            />
            <button
              class="btn-secondary"
              :disabled="opBusy || treeNewFolderBusy || !treeNewFolderName.trim()"
              @click="createFolderInTree"
            >{{ t("files.newFolderHere") }}</button>
          </div>
        </div>
        <div v-if="opQueue.length > 1" class="cross-queue">
          <div class="cross-queue-bar">
            <div class="cross-queue-fill" :style="{ width: (opQueue.filter(i => i.status === 'done' || i.status === 'failed').length / opQueue.length * 100) + '%' }"></div>
          </div>
          <div class="cross-queue-list">
            <div v-for="item in opQueue" :key="item.key" class="cross-queue-item">
              <span class="cross-queue-status" :class="`status-${item.status}`">
                <Icon :name="item.status === 'done' ? 'check' : item.status === 'failed' ? 'cross' : item.status === 'running' ? 'dot' : 'dot'" />
              </span>
              <span class="cross-queue-name">{{ item.kind === "dir" ? `${item.name}` : item.name }}<Icon v-if="item.kind === 'dir'" name="folder" /></span>
              <span v-if="item.error" class="cross-queue-error">{{ item.error }}</span>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" :disabled="opBusy" @click="closeOpModal">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="opBusy || destInsideSelectedDir" @click="confirmOp">{{ opModal.mode === "move" ? t("files.move") : t("files.copy") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- New folder modal -->
    <div v-if="newFolderModal" class="modal-backdrop" @click.self="closeNewFolderModal">
      <div class="modal">
        <div class="modal-title">{{ t("files.newFolderTitle") }}: /{{ path }}</div>
        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.folderName") }}</label>
          <input
            v-model="newFolderName"
            class="form-input new-folder-input"
            :placeholder="t('files.folderNamePlaceholder')"
            @keydown.enter="confirmNewFolder"
            @keydown.escape="closeNewFolderModal"
          />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" :disabled="newFolderBusy" @click="closeNewFolderModal">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="newFolderBusy || !newFolderName.trim()" @click="confirmNewFolder">
            {{ t("files.newFolderTitle") }}
          </button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- Delete confirm modal (single + batch), replacing window.confirm().
         Same reasoning as Sources.vue's mirror-copy confirm: a native
         confirm() can't be styled and blocks the whole page's event loop
         until a human answers it. -->
    <div v-if="deleteConfirmModal" class="modal-backdrop" @click.self="cancelDeleteConfirm">
      <div class="modal">
        <div class="modal-title">{{ t("files.deleteConfirmTitle") }}</div>
        <p class="modal-confirm-text">{{ deleteConfirmText }}</p>
        <div class="modal-actions">
          <button class="btn-secondary" :disabled="opBusy" @click="cancelDeleteConfirm">{{ t("common.cancel") }}</button>
          <button class="btn-danger" :disabled="opBusy" @click="confirmDelete">{{ t("files.deleteFile") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- Cross-source copy modal — batched + concurrent -->
    <div v-if="crossCopyModal" class="modal-backdrop" @click.self="closeCrossModal">
      <div class="modal">
        <div class="modal-title">
          {{ t("files.crossCopyTitle") }}:
          {{ crossCopyModal.files.length === 1 ? crossCopyModal.files[0].name : t("files.crossCopyNFiles", { n: crossCopyModal.files.length }) }}
        </div>
        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.source") }}</label>
          <select v-model="crossCopyDestSource" class="form-input" :disabled="crossCopyBusy">
            <option value="r2">{{ t("files.localR2") }}</option>
            <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name || s.id }}</option>
          </select>
        </div>
        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.crossCopyDestDir") }}</label>
          <input
            v-model="crossCopyDestPath"
            class="form-input"
            :placeholder="path"
            :disabled="crossCopyBusy"
            @keydown.enter="confirmCrossOp"
            @keydown.escape="closeCrossModal"
          />
          <span class="field-hint">{{ t("files.crossCopyDestDirHint") }}</span>
        </div>

        <!-- Per-file queue + overall progress bar — bytes are copied server-side
             (source adapter → dest adapter, never through this browser), so
             there's no per-file byte percentage to show; each item's real
             granularity is pending → copying → done/failed. -->
        <div v-if="crossCopyQueue.length" class="cross-queue">
          <div class="cross-queue-bar">
            <div class="cross-queue-fill" :style="{ width: (crossCopyQueue.filter(i => i.status === 'done' || i.status === 'failed').length / crossCopyQueue.length * 100) + '%' }"></div>
          </div>
          <div class="cross-queue-overall">
            {{ t("files.crossCopyProgress", {
              done: crossCopyQueue.filter(i => i.status === 'done').length,
              failed: crossCopyQueue.filter(i => i.status === 'failed').length,
              total: crossCopyQueue.length,
            }) }}
          </div>
          <div class="cross-queue-list">
            <div v-for="item in crossCopyQueue" :key="item.file.uri" class="cross-queue-item">
              <span class="cross-queue-status" :class="`status-${item.status}`">
                <Icon :name="item.status === 'done' ? 'check' : item.status === 'failed' ? 'cross' : item.status === 'copying' ? 'dot' : 'dot'" />
              </span>
              <span class="cross-queue-name">{{ item.file.name }}</span>
              <span v-if="item.error" class="cross-queue-error">{{ item.error }}</span>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn-secondary" :disabled="crossCopyBusy" @click="closeCrossModal">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="crossCopyBusy" @click="confirmCrossOp">{{ t("files.crossCopyBtn") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- Tag editor (single mode — batch lives in Library) -->
    <TagEditor
      :open="editorOpen"
      :mode="editorMode"
      :song-ids="editorMode === 'single' ? (editTargetId ? [editTargetId] : []) : editTargetIds"
      :initial-tags="editInitial"
      :existing-cover-url="editExistingCoverUrl"
      :busy="editBusy"
      :message="editMsg"
      :error="editErr"
      @submit="onTagEditorSubmit"
      @close="closeTagEditor"
    >
     <!-- Scrape button — single mode only, batch has no one obvious
          "which song" query to scrape against (same reasoning as Library.vue) -->
      <template v-if="editorMode === 'single'" #extras="{ form, apply }">
        <ScrapeButton
          :initial-query="scrapeQueryFromForm(form)"
          :song-master-id="editTargetId || ''"
          @apply="(r: ScrapeResult) => applyScrapeResult(form, apply, r)"
        />
      </template>
    </TagEditor>

    <!-- Tidy folder modal -->
    <div v-if="tidyOpen" class="modal-backdrop" @click.self="closeTidyFolder">
      <div class="modal tidy-modal">
        <div class="modal-title">{{ t("files.tidyTitle", { n: tidyTargetIds.length }) }}</div>

        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.tidyTemplate") }}</label>
          <input v-model="tidyTemplate" class="form-input" :placeholder="DEFAULT_TIDY_TEMPLATE" />
          <span class="field-hint">{{ t("files.tidyTemplateHint", { ph: "{albumArtist} {album} {artist} {title} {year} {track} {track:02d}", ex: DEFAULT_TIDY_TEMPLATE }) }}</span>
        </div>

        <label class="dry-run-row">
          <label class="toggle">
            <input type="checkbox" v-model="tidyDryRun" />
            <span class="toggle-slider"></span>
          </label>
          <span>{{ t("files.tidyDryRun") }}</span>
        </label>

        <div v-if="tidyPlanned.length" class="tidy-plan">
          <div class="tidy-plan-title mono-label">
            {{ tidyDryRun ? t("files.tidyPlanned") : t("files.tidyApplied") }} ({{ tidyPlanned.length }})
          </div>
          <div class="tidy-plan-list">
            <div v-for="(p, i) in tidyPlanned" :key="p.instanceId + i" class="tidy-row">
              <div class="tidy-from mono-label">{{ p.from }}</div>
              <div class="tidy-arrow"><Icon name="right" /></div>
              <div class="tidy-to mono-label">
                <template v-if="p.skipped">{{ t("files.tidySkipped", { reason: p.skipped }) }}</template>
                <template v-else>{{ p.to }}</template>
              </div>
            </div>
          </div>
        </div>

        <p v-if="tidyMsg" :class="['te-msg', { error: tidyErr }]">{{ tidyMsg }}</p>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeTidyFolder">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="tidyBusy || !tidyTemplate.trim()" @click="runTidyFolder">
            {{ tidyBusy ? t("common.loading") : t("files.tidyRun") }}
          </button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- Context menu — right-click in the entry list, long-press on touch.
         Teleported so no ancestor's overflow or stacking context can clip it. -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        ref="ctxMenuEl"
        class="ctx-menu"
        :style="ctxStyle"
        @click.stop
        @contextmenu.prevent.stop
      >
        <!-- Opened on a row that belongs to a multi-selection: the menu drives
             the whole selection, mirroring the batch action bar. -->
        <template v-if="ctxOnSelection">
          <div class="ctx-header">{{ t("files.selectedCount", { n: selectedTotal }) }}</div>
          <button
            class="ctx-item"
            :disabled="hasDirSelection"
            :title="hasDirSelection ? t('files.filesOnlyAction') : ''"
            @click="ctxRun(openBatchTagEditor)"
          ><Icon name="note" /> {{ t("files.batchEditTags") }}</button>
          <button v-if="isR2" class="ctx-item" @click="ctxRun(openBatchMoveModal)"><Icon name="right" /> {{ t("files.batchMove") }}</button>
          <button
            class="ctx-item"
            :disabled="hasDirSelection"
            :title="hasDirSelection ? t('files.filesOnlyAction') : ''"
            @click="ctxRun(openCrossModalBatch)"
          ><Icon name="copy" /> {{ t("files.crossCopySelected", { n: selectedTotal }) }}</button>
          <button v-if="isR2" class="ctx-item ctx-danger" @click="ctxRun(openBatchDeleteConfirm)"><Icon name="cross" /> {{ t("files.batchDelete") }}</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="ctxRun(clearSelection)"><Icon name="empty" /> {{ t("files.clearSelection") }}</button>
        </template>

        <template v-else-if="ctxFile">
          <div class="ctx-header">{{ ctxFile.name }}</div>
          <button
            v-if="canEditTags && isAudio(ctxFile.name)"
            class="ctx-item"
            @click="ctxRun(() => openTagEditor(ctxFile!))"
          ><Icon name="note" /> {{ t("files.editTags") }}</button>
          <button v-if="canUpload" class="ctx-item" @click="ctxRun(() => openCrossModal(ctxFile!))"><Icon name="copy" /> {{ t("files.crossCopyTo") }}</button>
          <template v-if="isR2 && canUpload">
            <div class="ctx-sep"></div>
            <button class="ctx-item" @click="ctxRun(() => startRename(ctxFile!))"><Icon name="edit" /> {{ t("files.rename") }}</button>
            <button class="ctx-item" @click="ctxRun(() => openMoveModal(ctxFile!, 'move'))"><Icon name="right" /> {{ t("files.moveTo") }}</button>
            <button class="ctx-item" @click="ctxRun(() => openMoveModal(ctxFile!, 'copy'))"><Icon name="copy" /> {{ t("files.copyTo") }}</button>
            <button class="ctx-item ctx-danger" :disabled="opBusy" @click="ctxRun(() => openDeleteConfirm(ctxFile!))"><Icon name="cross" /> {{ t("files.deleteFile") }}</button>
          </template>
          <div class="ctx-sep"></div>
          <button v-if="canUpload" class="ctx-item" @click="ctxRun(() => toggleCrossSelect(ctxFile!))">
            <Icon name="check" /> {{ selectedFiles.has(ctxFile.uri) ? t("files.deselect") : t("files.select") }}
          </button>
          <button class="ctx-item" @click="ctxRun(loadDir)"><Icon name="refresh" /> {{ t("files.refresh") }}</button>
        </template>

        <template v-else-if="ctxDir">
          <div class="ctx-header">{{ ctxDir.name }}</div>
          <button class="ctx-item" @click="ctxRun(() => enterDir(ctxDir!.name))"><Icon name="folder" /> {{ t("files.open") }}</button>
          <!-- Folder move/delete/rename all go through the R2-only
               moveFolder/deleteFolder endpoints. -->
          <template v-if="isR2 && canUpload">
            <div class="ctx-sep"></div>
            <button class="ctx-item" @click="ctxRun(() => startRenameDir(ctxDir!))"><Icon name="edit" /> {{ t("files.renameFolder") }}</button>
            <button class="ctx-item" @click="ctxRun(() => openDirMoveModal(ctxDir!))"><Icon name="right" /> {{ t("files.moveFolderTo") }}</button>
            <button class="ctx-item ctx-danger" :disabled="opBusy" @click="ctxRun(() => openDirDeleteConfirm(ctxDir!))"><Icon name="cross" /> {{ t("files.deleteFolder") }}</button>
          </template>
          <div class="ctx-sep"></div>
          <button v-if="canUpload" class="ctx-item" @click="ctxRun(() => toggleDirSelect(ctxDir!))">
            <Icon name="check" /> {{ selectedDirs.has(ctxDir.name) ? t("files.deselect") : t("files.select") }}
          </button>
          <button class="ctx-item" @click="ctxRun(loadDir)"><Icon name="refresh" /> {{ t("files.refresh") }}</button>
        </template>

        <template v-else>
          <button v-if="canUpload" class="ctx-item" @click="ctxRun(openNewFolderModal)"><Icon name="folder" /> {{ t("files.newFolderTitle") }}</button>
          <button
            v-if="canUpload && !allSelected && dirs.length + files.length > 0"
            class="ctx-item"
            @click="ctxRun(toggleSelectAll)"
          ><Icon name="check" /> {{ t("files.selectAll") }}</button>
          <button v-if="selectedTotal > 0" class="ctx-item" @click="ctxRun(clearSelection)"><Icon name="empty" /> {{ t("files.clearSelection") }}</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="ctxRun(loadDir)"><Icon name="refresh" /> {{ t("files.refresh") }}</button>
        </template>
      </div>
    </Teleport>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.page-actions { display: flex; gap: 0.5rem; align-items: center; }
.scan-progress {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-accent-primary);
  letter-spacing: 0.05em;
  animation: pulse 2s ease-in-out infinite;
}
.pending-badge {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--color-border-default);
  border-radius: 2px;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
}

.source-bar {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  margin-bottom: 1.25rem;
}
.source-bar-label {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-right: 0.25rem;
}
.source-tab {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  padding: 0.4rem 0.9rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.1s;
}
.source-tab:hover { background: var(--color-bg-tertiary); color: var(--color-text-primary); }
.source-tab.active {
  background: var(--color-accent-dim);
  border-color: var(--color-accent-primary);
  color: var(--color-accent-primary);
}

.upload-panel { margin-bottom: 1.25rem; }
.upload-file-row { display: flex; gap: 0.5rem; align-items: center; }
.upload-file-row .form-input { flex: 1; min-width: 0; }
.upload-type-select { width: auto; flex: 0 0 auto; }
.sync-upload-row, .sync-options-row, .openyyy-guide { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.65rem; flex-wrap: wrap; }
.sync-upload-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.sync-options-row { padding: 0.55rem 0; border-top: 1px solid var(--color-border-subtle); }
.openyyy-guide { padding: 0.6rem 0.75rem; border: 1px solid var(--color-border-subtle); background: var(--color-bg-primary); font-size: var(--fs-xs); color: var(--color-text-muted); }
.openyyy-guide strong { color: var(--color-text-secondary); }
.upload-dest {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-accent-primary);
  padding: 0.45rem 0;
  word-break: break-all;
}
.upload-options-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.6rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--color-border-subtle);
}
.upload-options-label { font-size: var(--fs-sm); color: var(--color-text-secondary); }
.upload-options-hint { font-size: var(--fs-xs); color: var(--color-text-muted); }
.pre-transcode-block { margin-top: 0.6rem; border: 1px solid var(--color-border-default); background: var(--color-bg-primary); }
.pre-transcode-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  width: 100%; justify-content: space-between; padding: 0.55rem 0.7rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.pre-transcode-toggle:hover { color: var(--color-text-primary); }
.pre-transcode-caret { color: var(--color-accent-primary); }
.pre-transcode-body { padding: 0.3rem 0.7rem 0.6rem; border-top: 1px solid var(--color-border-subtle); }
.pre-transcode-profiles { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.4rem; }
.pre-transcode-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  cursor: pointer;
  user-select: none;
}
.pre-transcode-pill input { margin: 0; }
.upload-msg { font-family: var(--font-mono); font-size: var(--fs-sm); margin-top: 0.5rem; color: var(--color-status-success); }
.upload-msg.error { color: var(--color-status-error); }

/* Upload queue — these classes existed in the template from the start
   but were never given rules, so the per-file progress bars rendered as
   invisible/unstyled divs. Fixed here alongside the analogous cross-copy
   queue below. */
.upload-queue { margin-top: 0.75rem; padding-top: 0.6rem; border-top: 1px solid var(--color-border-subtle); }
.upload-queue-header { font-size: var(--fs-xs); color: var(--color-text-muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.4rem; }
.upload-queue-item { display: flex; align-items: center; gap: 0.6rem; padding: 0.2rem 0; font-family: var(--font-mono); font-size: var(--fs-sm); }
.upload-queue-item.excluded { opacity: 0.55; }
.upload-queue-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }
.upload-kind, .upload-pair { flex-shrink: 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.upload-kind { border: 1px solid var(--color-border-subtle); padding: 0.1rem 0.3rem; }
.upload-pair { max-width: 10rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upload-queue-bar { width: 120px; height: 4px; background: var(--color-border); border-radius: 2px; overflow: hidden; flex-shrink: 0; }
.upload-queue-fill { height: 100%; background: var(--color-accent-primary); transition: width 0.2s; }
.upload-queue-fill.fill-error { background: var(--color-status-error); }
.upload-queue-pct { width: 3em; text-align: right; flex-shrink: 0; color: var(--color-text-muted); font-size: var(--fs-xs); }
.upload-queue-overall { margin-top: 0.4rem; font-size: var(--fs-sm); color: var(--color-text-muted); }

/* Cross-source copy batch selection + queue */
.cross-select-box { flex-shrink: 0; margin-right: 0.4rem; cursor: pointer; accent-color: var(--color-accent-primary); }

/* Select-all header row above the entry list */
.select-all-row { cursor: pointer; user-select: none; background: var(--color-bg-primary); }
.select-all-label {
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.select-all-count { margin-left: auto; font-size: var(--fs-xs); color: var(--color-accent-primary); }

/* Destination folder tree in the move/copy modal */
.dest-tree {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
}
.dest-tree-row {
  display: flex; align-items: center; gap: 0.35rem;
  padding: 0.25rem 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  cursor: pointer;
  border-left: 2px solid transparent;
  color: var(--color-text-secondary);
}
.dest-tree-row:hover { background: var(--color-bg-tertiary); color: var(--color-text-primary); }
.dest-tree-row.selected {
  background: var(--color-accent-dim);
  border-left-color: var(--color-accent-primary);
  color: var(--color-accent-primary);
}
.dest-tree-caret {
  flex-shrink: 0; width: 1.4em;
  background: none; border: none; padding: 0;
  color: var(--color-text-muted);
  font-size: var(--fs-xs);
  cursor: pointer;
  line-height: 1.4;
}
.dest-tree-caret:hover { color: var(--color-text-primary); }
.dest-tree-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dest-tree-loading {
  padding: 0.75rem; text-align: center;
  font-family: var(--font-mono); font-size: var(--fs-sm);
  color: var(--color-text-muted);
}
.dest-selected {
  margin-top: 0.4rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-accent-primary);
  word-break: break-all;
}
.dest-warning {
  margin: 0.3rem 0 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-status-error);
}
.dest-newfolder { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
.dest-newfolder .form-input { flex: 1; min-width: 0; }
.dest-newfolder .btn-secondary { flex-shrink: 0; font-size: var(--fs-xs); padding: 0.25rem 0.6rem; white-space: nowrap; }
.btn-new-folder { margin-left: 0.6rem; font-size: var(--fs-xs); padding: 0.25rem 0.6rem; }

/* Batch action bar (tag-edit / move / delete / cross-copy) shown under
   the breadcrumb whenever at least one file is checked. */
.batch-actions-bar {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-secondary);
}
.batch-actions-bar > button { font-size: var(--fs-xs); padding: 0.25rem 0.6rem; }
.batch-actions-count {
  font-family: var(--font-mono); font-size: var(--fs-xs);
  color: var(--color-text-muted); letter-spacing: 0.05em;
  margin-right: 0.3rem;
}
.batch-actions-clear { margin-left: auto; }
.modal-confirm-text { margin: 0.5rem 0 0; font-size: var(--fs-sm); color: var(--color-text-secondary); line-height: 1.5; }

.cross-queue { margin-top: 0.9rem; padding-top: 0.75rem; border-top: 1px solid var(--color-border-subtle); }
.cross-queue-bar { height: 4px; background: var(--color-border); border-radius: 2px; overflow: hidden; margin-bottom: 0.5rem; }
.cross-queue-fill { height: 100%; background: var(--color-accent-primary); transition: width 0.2s; }
.cross-queue-overall { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); margin-bottom: 0.5rem; }
.cross-queue-list { max-height: 220px; overflow-y: auto; }
.cross-queue-item { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.15rem 0; font-family: var(--font-mono); font-size: var(--fs-sm); }
.cross-queue-status { flex-shrink: 0; width: 1.2em; text-align: center; color: var(--color-text-muted); }
.cross-queue-status.status-done { color: var(--color-status-success); }
.cross-queue-status.status-failed { color: var(--color-status-error); }
.cross-queue-status.status-copying,
.cross-queue-status.status-running { color: var(--color-accent-primary); }
.cross-queue-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }
.cross-queue-error { color: var(--color-status-error); font-size: var(--fs-xs); }

.file-browser {
  margin: 0 -1.75rem;
  border-top: 1px solid var(--color-border-subtle);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-secondary);
}
.breadcrumb {
  display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap;
  padding: 0.75rem 1.75rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
}
.crumb {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  background: none; border: none; padding: 0;
  color: var(--color-accent-primary);
  cursor: pointer;
}
.crumb:hover { text-decoration: underline; }
.crumb:disabled { color: var(--color-text-primary); cursor: default; text-decoration: none; }
.crumb-sep { color: var(--color-text-muted); }
.browser-stats {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.08em;
}
.file-sort-controls { display: flex; align-items: center; gap: 0.35rem; font-size: var(--fs-xs); color: var(--color-text-muted); }
.file-sort-controls .form-input { width: auto; padding: 0.2rem 0.35rem; font-size: var(--fs-xs); }
.sort-direction { padding: 0.2rem 0.45rem; font-size: var(--fs-xs); }

.entry-list { min-height: 12rem; display: flex; flex-direction: column; }
.folders-last .dir-row { order: 2; }
.folders-last .file-row { order: 1; }
.folders-last .select-all-row { order: 0; }
.list-loading {
  padding: 1.5rem; text-align: center;
  font-family: var(--font-mono); font-size: var(--fs-sm);
  color: var(--color-text-muted);
  animation: pulse 2s ease-in-out infinite;
}
.entry-row {
  display: flex; align-items: center; gap: 0.7rem;
  padding: 0.55rem 1.75rem;
  border-bottom: 1px solid var(--color-border-subtle);
  border-left: 2px solid transparent;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.entry-row:last-child { border-bottom: none; }
.dir-row { cursor: pointer; transition: all 0.1s; }
.dir-row:hover {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent-primary);
  color: var(--color-accent-primary);
}
.row-renaming { background: var(--color-bg-tertiary); border-left-color: var(--color-accent-primary); }
.entry-icon { flex-shrink: 0; }
.file-icon { color: var(--color-text-muted); }
.entry-name {
  min-width: 0; flex: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--color-text-primary);
}
.dir-row:hover .entry-name { color: var(--color-accent-primary); }
.entry-size { flex-shrink: 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.empty-state { padding: 2rem; text-align: center; }

@media (max-width: 960px) {
  .file-browser { margin: 0 -1rem; }
  .breadcrumb, .entry-row { padding-left: 1rem; padding-right: 1rem; }
}

/* R2 operation buttons */
.op-btn {
  flex-shrink: 0;
  background: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  padding: 0.15rem 0.45rem;
  font-size: var(--fs-xs);
  cursor: pointer;
  color: var(--color-text-muted);
  opacity: 0.55;
  transition: all 0.1s;
  line-height: 1.4;
}
.entry-row:hover .op-btn { opacity: 1; }
.op-btn:hover { color: var(--color-text-primary); border-color: var(--color-border-default); background: var(--color-bg-tertiary); }
.op-confirm:hover { color: var(--color-status-success); border-color: var(--color-status-success); }
.op-confirm, .op-cancel { opacity: 1; }
/* The row's one way in, so it stays legible without a hover — touch has none. */
.op-menu { opacity: 0.75; }

.rename-input {
  flex: 1;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-accent-primary);
  border-radius: 2px;
  padding: 0.2rem 0.5rem;
  color: var(--color-text-primary);
  outline: none;
}

/* Context menu — teleported to <body>, so it sits below the modals
   (z-index 1000) but above everything on the page. */
.ctx-menu {
  position: fixed;
  z-index: 900;
  min-width: 190px;
  max-width: 280px;
  padding: 0.25rem 0;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-default);
  border-radius: 2px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.ctx-header {
  padding: 0.35rem 0.75rem 0.4rem;
  margin-bottom: 0.2rem;
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-text-muted);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.4rem 0.75rem;
  background: none;
  border: none;
  text-align: left;
  font-family: inherit;
  font-size: inherit;
  color: var(--color-text-secondary);
  white-space: nowrap;
  cursor: pointer;
}
.ctx-item:hover:not(:disabled), .ctx-item:focus-visible {
  background: var(--color-bg-tertiary);
  color: var(--color-accent-primary);
  outline: none;
}
.ctx-item:disabled { opacity: 0.4; cursor: not-allowed; }
.ctx-danger:hover:not(:disabled) { color: var(--color-status-error); }
.ctx-sep { height: 1px; margin: 0.25rem 0; background: var(--color-border-subtle); }

/* A long press opens the menu; on touch it must not also start a text
   selection or raise the platform callout. */
@media (pointer: coarse) {
  .entry-row { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
}

.field-hint {
  display: block;
  margin-top: 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}

.tidy-modal { width: min(720px, 94vw); max-height: 90vh; overflow-y: auto; }
.dry-run-row {
  display: flex; align-items: center; gap: 0.5rem;
  margin-top: 0.75rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.tidy-plan { margin-top: 0.85rem; }
.tidy-plan-title { color: var(--color-accent-primary); margin-bottom: 0.4rem; }
.tidy-plan-list {
  max-height: 45vh;
  overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
  padding: 0.4rem;
}
.tidy-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 0.5rem;
  align-items: center;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--fs-xs);
}
.tidy-row:last-child { border-bottom: none; }
.tidy-from { color: var(--color-text-muted); word-break: break-all; }
.tidy-arrow { color: var(--color-accent-primary); font-family: var(--font-mono); }
.tidy-to { color: var(--color-text-primary); word-break: break-all; }
.te-msg {
  margin-top: 0.6rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-status-success);
}
.te-msg.error { color: var(--color-status-error); }

/* the Files-page work-queue HUD (`.work-queue-card` + `.wq-*` rules)
   has been removed entirely. The canonical "Worker 预解析" panel now lives
   in Tools.vue. Keeping this comment so a future grep for "wq-" doesn't
   waste time re-discovering the deletion. */
</style>
