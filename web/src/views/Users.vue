
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import { activationDisplay, toDatetimeLocal, fromDatetimeLocal, type ActivationStatus } from "../lib/activation";
import Icon from "../components/Icon.vue";

const { t, locale } = useI18n();
const { username: currentUsername, isAdmin, isSuperAdmin, hasPerm, edgesonicFetch, edgesonicPost, restUrl } = useAuth();
interface UserRow {
  username: string; level: number; enabled: boolean;
  // Activation columns are optional until the backend ships them; rows
  // without the field render "—" and stay read-only.
  activationStatus: ActivationStatus | null;
  activatedUntil: number | null;
  hasAvatar: boolean;
}
const users = ref<UserRow[]>([]);
const loading = ref(true);
const showForm = ref(false);
const form = ref({ username: "", password: "", level: 1 });
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const levelColors: Record<number, string> = { 0: "muted", 1: "success", 2: "info", 3: "warning" };

const avatarBust = ref<Record<string, number>>({});
function avatarSrc(u: string): string {
  const ts = avatarBust.value[u] ?? 0;
  return restUrl("getAvatar", { username: u, ...(ts ? { _ts: String(ts) } : {}) });
}
function onAvatarError(e: Event) {
  // getAvatar returns 404 when avatar_r2_key is null. Hide the broken img and
  // let the CSS .avatar-fallback show through (placed behind the img).
  const img = e.target as HTMLImageElement;
  img.style.visibility = "hidden";
}

const showAvatarModal = ref(false);
const avatarTarget = ref<{ username: string } | null>(null);
const avatarPreview = ref<string>(""); // data: URL preview of compressed JPEG
const avatarBase64 = ref<string>("");  // raw base64 (no data: prefix) — sent to setAvatar
const avatarMime = ref<string>("image/jpeg");
const avatarUploading = ref(false);

function openAvatarModal(u: { username: string }) {
  avatarTarget.value = { username: u.username };
  avatarPreview.value = "";
  avatarBase64.value = "";
  avatarMime.value = "image/jpeg";
  showAvatarModal.value = true;
}
function closeAvatarModal() {
  showAvatarModal.value = false;
  avatarTarget.value = null;
  avatarPreview.value = "";
  avatarBase64.value = "";
}

async function compressToJpeg(file: File): Promise<{ dataUrl: string; base64: string; mime: string }> {
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image decode failed"));
      i.src = blobUrl;
    });
    const longEdge = 200;
    const scale = Math.min(1, longEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    ctx.fillStyle = "#fff"; // flatten alpha so JPEG doesn't show black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const MAX_BYTES = 100 * 1024;
    let quality = 0.85;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    // dataUrl length → approx bytes: subtract header then *3/4
    const estimateBytes = (s: string) => Math.floor((s.length - s.indexOf(",") - 1) * 3 / 4);
    while (estimateBytes(dataUrl) > MAX_BYTES && quality > 0.4) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return { dataUrl, base64, mime: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function onAvatarFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  // Pre-validate against the worker's 500KB limit AFTER compression — but we
  // can warn early if the source is huge (e.g. 20MB raw camera shot would
  // still compress fine, so only block clearly non-image files).
  if (!/^image\//.test(file.type)) {
    showToast(t("users.avatar.invalidMime"), "error");
    input.value = "";
    return;
  }
  try {
    const { dataUrl, base64, mime } = await compressToJpeg(file);
    avatarPreview.value = dataUrl;
    avatarBase64.value = base64;
    avatarMime.value = mime;
  } catch {
    showToast(t("users.avatar.uploadFailed"), "error");
  }
  // Allow re-selecting the same file later
  input.value = "";
}

function clearAvatarSelection() {
  avatarPreview.value = "";
  avatarBase64.value = "";
}

async function submitAvatar() {
  if (!avatarTarget.value || !avatarBase64.value) return;
  avatarUploading.value = true;
  try {
    const raw = await edgesonicPost("users/setAvatar", {
      username: avatarTarget.value.username,
      imageBase64: avatarBase64.value,
      mimeType: avatarMime.value,
    });
    const resp = JSON.parse(raw) as { ok?: boolean; error?: string };
    if (!resp.ok) throw new Error(resp.error || "upload failed");
    // Bust cache so the row thumb refetches the new bytes, and mark the row as
    // having one so the (previously skipped) request is now made.
    avatarBust.value = { ...avatarBust.value, [avatarTarget.value.username]: Date.now() };
    const row = users.value.find((u) => u.username === avatarTarget.value!.username);
    if (row) row.hasAvatar = true;
    showToast(t("users.avatar.uploaded"));
    closeAvatarModal();
  } catch {
    showToast(t("users.avatar.uploadFailed"), "error");
  } finally {
    avatarUploading.value = false;
  }
}

interface OkJson { ok: boolean; error?: string }
interface UsersListJson extends OkJson {
  users?: Array<{
    username: string; level: number; enabled: boolean;
    activationStatus?: string; activatedUntil?: number | null; hasAvatar?: boolean;
  }>;
}

function safeParse<T extends OkJson>(raw: string): T {
  try { return JSON.parse(raw) as T; } catch { return { ok: false, error: "bad_json" } as T; }
}

function asActivationStatus(v: unknown): ActivationStatus | null {
  return v === "permanent" || v === "active_until" || v === "disabled" ? v : null;
}

async function load() {
  loading.value = true;
  try {
    const raw = await edgesonicFetch("users/list");
    const resp = safeParse<UsersListJson>(raw);
    if (!resp.ok || !Array.isArray(resp.users)) { users.value = []; return; }
    users.value = resp.users.map((u) => ({
      username: u.username || "",
      level: typeof u.level === "number" ? u.level : parseInt(String(u.level ?? "1")),
      enabled: !!u.enabled,
      activationStatus: asActivationStatus(u.activationStatus),
      activatedUntil: typeof u.activatedUntil === "number" ? u.activatedUntil : null,
      // Older servers omit the flag; assume an avatar exists so the request
      // still happens and the error handler keeps its old fallback role.
      hasAvatar: u.hasAvatar !== false,
    }));
  } catch { users.value = []; } finally {
    loading.value = false;
  }
}

async function addUser() {
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("users/create", form.value));
    if (!resp.ok) throw new Error(resp.error || "create failed");
    showForm.value = false; form.value = { username: "", password: "", level: 1 };
    load(); showToast(t("users.created"));
  } catch { showToast(t("users.createFailed"), "error"); }
}

async function updateUser(user: { username: string; level?: number; enabled?: number }) {
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("users/update", user));
    if (!resp.ok) throw new Error(resp.error || "update failed");
    load(); showToast(t("users.updated"));
  } catch { showToast(t("users.updateFailed"), "error"); }
}

async function deleteUser(username: string) {
  if (!confirm(t("users.deleteConfirm", { name: username }))) return;
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("users/delete", { username }));
    if (!resp.ok) throw new Error(resp.error || "delete failed");
    load(); showToast(t("users.deleted"));
  } catch { showToast(t("users.deleteFailed"), "error"); }
}

function toggleEnabled(u: { username: string; enabled: boolean }) {
  updateUser({ username: u.username, enabled: u.enabled ? 0 : 1 });
}

function changeLevel(u: { username: string; level: number }, newLevel: number) {
  updateUser({ username: u.username, level: newLevel });
}

const canEditAvatar = (u: { username: string }) =>
  u.username === currentUsername.value || isAdmin.value;

const canSubmitAvatar = computed(() => !!avatarBase64.value && !avatarUploading.value);

// ---- Activation status column + editor ----
const canManageActivation = computed(() => hasPerm("manage_users") && hasPerm("manage_activation"));

function formatTs(sec: number | null): string {
  return sec ? new Date(sec * 1000).toLocaleString(locale.value) : "—";
}

function activationCell(u: UserRow): { text: string; cls: string } | null {
  if (u.activationStatus === null) return null;
  const display = activationDisplay(u.activationStatus, u.activatedUntil);
  switch (display) {
    case "permanent": return { text: t("activation.state.permanent"), cls: "success" };
    case "until": return { text: t("activation.state.until", { date: formatTs(u.activatedUntil) }), cls: "info" };
    case "expired": return { text: t("activation.state.expired"), cls: "error" };
    case "disabled": return { text: t("activation.state.disabled"), cls: "error" };
  }
}

// Targets must be non-admin and not the current account (server enforces too).
const canEditActivation = (u: UserRow) =>
  canManageActivation.value && u.level < 3 && u.username !== currentUsername.value && u.activationStatus !== null;

const showActModal = ref(false);
const actTarget = ref<UserRow | null>(null);
const actMode = ref<"permanent" | "until" | "disabled">("permanent");
const actUntilInput = ref("");
const actSaving = ref(false);

function openActModal(u: UserRow) {
  actTarget.value = u;
  const display = u.activationStatus ? activationDisplay(u.activationStatus, u.activatedUntil) : "permanent";
  actMode.value = display === "permanent" ? "permanent" : display === "disabled" ? "disabled" : "until";
  actUntilInput.value = toDatetimeLocal(u.activatedUntil);
  showActModal.value = true;
}
function closeActModal() {
  showActModal.value = false;
  actTarget.value = null;
}

async function saveActivation() {
  if (!actTarget.value || actSaving.value) return;
  const body: { username: string; mode: string; until?: number } = {
    username: actTarget.value.username, mode: actMode.value,
  };
  if (actMode.value === "until") {
    const until = fromDatetimeLocal(actUntilInput.value);
    if (until === null) { showToast(t("users.activation.badDate"), "error"); return; }
    body.until = until;
  }
  actSaving.value = true;
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("activation/set", body));
    if (!resp.ok) throw new Error(resp.error || "set failed");
    showToast(t("users.activation.saved"));
    closeActModal();
    load();
  } catch { showToast(t("users.activation.saveFailed"), "error"); }
  finally { actSaving.value = false; }
}

// Account actions inside the activation modal. Freeze is a one-click
// mode=disabled; the revokes cut web sessions / issued client credentials so
// a compromised or off-boarded account drops out immediately.
const actActionBusy = ref("");

async function freezeTarget() {
  if (!actTarget.value || actActionBusy.value) return;
  if (!confirm(t("users.activation.freezeConfirm", { name: actTarget.value.username }))) return;
  actActionBusy.value = "freeze";
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("activation/set", {
      username: actTarget.value.username, mode: "disabled",
    }));
    if (!resp.ok) throw new Error(resp.error || "freeze failed");
    showToast(t("users.activation.frozen"));
    closeActModal();
    load();
  } catch { showToast(t("users.activation.saveFailed"), "error"); }
  finally { actActionBusy.value = ""; }
}

async function revokeTarget(kind: "revokeSessions" | "revokeCredentials") {
  if (!actTarget.value || actActionBusy.value) return;
  if (!confirm(t(`users.activation.${kind}Confirm`, { name: actTarget.value.username }))) return;
  actActionBusy.value = kind;
  try {
    const resp = safeParse<OkJson & { revoked?: number }>(
      await edgesonicPost(`activation/${kind}`, { username: actTarget.value.username }),
    );
    if (!resp.ok) throw new Error(resp.error || "revoke failed");
    showToast(t(`users.activation.${kind}Done`, { n: resp.revoked ?? 0 }));
  } catch { showToast(t("users.activation.saveFailed"), "error"); }
  finally { actActionBusy.value = ""; }
}

// ---- Invite codes panel ----
interface InviteCode {
  code: string; kind: "window" | "duration" | "permanent";
  windowStart: number | null; windowEnd: number | null; durationDays: number | null;
  maxUses: number; usedCount: number; note: string;
  revoked: boolean; createdBy: string; createdAt: number;
}
const showInvites = ref(false);
const codes = ref<InviteCode[]>([]);
const codesLoading = ref(false);
const showCodeForm = ref(false);
const codeForm = ref({
  kind: "duration" as "window" | "duration" | "permanent",
  windowStart: "", windowEnd: "", durationDays: 30, maxUses: 1, note: "",
});
const codeCreating = ref(false);
const createdCode = ref("");

function toggleInvites() {
  showInvites.value = !showInvites.value;
  if (showInvites.value && !codes.value.length) void loadCodes();
}

async function loadCodes() {
  codesLoading.value = true;
  try {
    const resp = safeParse<OkJson & { codes?: Array<Partial<InviteCode>> }>(
      await edgesonicFetch("activation/codes"));
    if (!resp.ok || !Array.isArray(resp.codes)) { codes.value = []; return; }
    codes.value = resp.codes.map((c) => ({
      code: c.code || "",
      kind: c.kind === "window" || c.kind === "permanent" ? c.kind : "duration",
      windowStart: typeof c.windowStart === "number" ? c.windowStart : null,
      windowEnd: typeof c.windowEnd === "number" ? c.windowEnd : null,
      durationDays: typeof c.durationDays === "number" ? c.durationDays : null,
      maxUses: typeof c.maxUses === "number" ? c.maxUses : 1,
      usedCount: typeof c.usedCount === "number" ? c.usedCount : 0,
      note: typeof c.note === "string" ? c.note : "",
      revoked: !!c.revoked,
      createdBy: c.createdBy || "",
      createdAt: typeof c.createdAt === "number" ? c.createdAt : 0,
    }));
  } catch { codes.value = []; }
  finally { codesLoading.value = false; }
}

function codeKindSummary(c: InviteCode): string {
  if (c.kind === "permanent") return t("users.invites.kindPermanent");
  if (c.kind === "window") return `${formatTs(c.windowStart)} → ${formatTs(c.windowEnd)}`;
  return t("users.invites.durationSummary", { n: c.durationDays ?? 0 });
}

function codeStatus(c: InviteCode): { text: string; cls: string } {
  if (c.revoked) return { text: t("users.invites.statusRevoked"), cls: "error" };
  if (c.usedCount >= c.maxUses) return { text: t("users.invites.statusExhausted"), cls: "muted" };
  return { text: t("users.invites.statusActive"), cls: "success" };
}

async function createCode() {
  if (codeCreating.value) return;
  const f = codeForm.value;
  const body: Record<string, unknown> = { kind: f.kind, maxUses: f.maxUses, note: f.note.trim() };
  if (f.kind === "window") {
    const start = fromDatetimeLocal(f.windowStart);
    const end = fromDatetimeLocal(f.windowEnd);
    if (start === null || end === null || end <= start) {
      showToast(t("users.invites.badWindow"), "error");
      return;
    }
    body.windowStart = start;
    body.windowEnd = end;
  } else if (f.kind === "duration") {
    if (!Number.isFinite(f.durationDays) || f.durationDays < 1) {
      showToast(t("users.invites.badDuration"), "error");
      return;
    }
    body.durationDays = Math.floor(f.durationDays);
  }
  codeCreating.value = true;
  try {
    const resp = safeParse<OkJson & { code?: string }>(await edgesonicPost("activation/codes", body));
    if (!resp.ok || !resp.code) throw new Error(resp.error || "create failed");
    createdCode.value = resp.code;
    showToast(t("users.invites.created"));
    void loadCodes();
  } catch { showToast(t("users.invites.createFailed"), "error"); }
  finally { codeCreating.value = false; }
}

async function revokeCode(code: string) {
  if (!confirm(t("users.invites.revokeConfirm", { code }))) return;
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("activation/codes/revoke", { code }));
    if (!resp.ok) throw new Error(resp.error || "revoke failed");
    showToast(t("users.invites.revoked"));
    void loadCodes();
  } catch { showToast(t("users.invites.revokeFailed"), "error"); }
}

async function copyCode(code: string) {
  try { await navigator.clipboard.writeText(code); showToast(t("common.copied")); }
  catch { showToast(t("users.invites.copyFailed"), "error"); }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("users.label") }}</div>
        <h1 class="page-title">{{ t("users.title") }}</h1>
      </div>
      <div class="header-actions">
        <button v-if="canManageActivation" class="btn-secondary" @click="toggleInvites">
          {{ showInvites ? t("users.invites.hide") : t("users.invites.open") }}
        </button>
        <button v-if="isAdmin" :class="showForm ? 'btn-secondary' : 'btn-primary'" @click="showForm = !showForm">{{ showForm ? t("common.cancel") : t("users.add") }}</button>
      </div>
    </div>

    <div v-if="showForm" class="card" style="margin-bottom:1.25rem; max-width:450px">
      <div class="card-header"><span class="card-title">{{ t("users.newUser") }}</span></div>
      <div style="display:flex; flex-direction:column; gap:0.8rem">
        <div class="form-group"><label class="form-label">{{ t("users.username") }}</label><input v-model="form.username" maxlength="64" class="form-input" /></div>
        <div class="form-group"><label class="form-label">{{ t("users.password") }}</label><input v-model="form.password" type="password" maxlength="256" class="form-input" /></div>
        <div class="form-group">
          <label class="form-label">{{ t("users.level") }}</label>
          <select v-model="form.level" class="form-select">
            <option v-if="isSuperAdmin" :value="3">3 — {{ t("users.levels.super") }}</option>
            <option :value="2">2 — {{ t("users.levels.admin") }}</option>
            <option :value="1">1 — {{ t("users.levels.user") }}</option>
            <option :value="0">0 — {{ t("users.levels.guest") }}</option>
          </select>
        </div>
        <button class="btn-primary" @click="addUser">{{ t("users.create") }}</button>
      </div>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <!-- Invite codes management -->
    <div v-if="showInvites && canManageActivation" class="card invites-card">
      <div class="card-header">
        <span class="card-title">{{ t("users.invites.title") }}</span>
        <button class="btn-secondary btn-sm" @click="showCodeForm = !showCodeForm; createdCode = ''">
          {{ showCodeForm ? t("common.cancel") : t("users.invites.create") }}
        </button>
      </div>

      <div v-if="showCodeForm" class="invite-form">
        <div class="form-group">
          <label class="form-label">{{ t("users.invites.kind") }}</label>
          <div class="seg">
            <button type="button" :class="['seg-btn', { active: codeForm.kind === 'duration' }]" @click="codeForm.kind = 'duration'">{{ t("users.invites.kindDuration") }}</button>
            <button type="button" :class="['seg-btn', { active: codeForm.kind === 'window' }]" @click="codeForm.kind = 'window'">{{ t("users.invites.kindWindow") }}</button>
            <button type="button" :class="['seg-btn', { active: codeForm.kind === 'permanent' }]" @click="codeForm.kind = 'permanent'">{{ t("users.invites.kindPermanent") }}</button>
          </div>
        </div>
        <div v-if="codeForm.kind === 'duration'" class="form-group">
          <label class="form-label">{{ t("users.invites.durationDays") }}</label>
          <input v-model.number="codeForm.durationDays" type="number" min="1" max="36500" class="form-input invite-num" />
        </div>
        <template v-if="codeForm.kind === 'window'">
          <div class="form-group">
            <label class="form-label">{{ t("users.invites.windowStart") }}</label>
            <input v-model="codeForm.windowStart" type="datetime-local" class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("users.invites.windowEnd") }}</label>
            <input v-model="codeForm.windowEnd" type="datetime-local" class="form-input" />
          </div>
        </template>
        <div class="form-group">
          <label class="form-label">{{ t("users.invites.maxUses") }}</label>
          <input v-model.number="codeForm.maxUses" type="number" min="1" max="100000" class="form-input invite-num" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("users.invites.note") }} <span class="act-none">({{ t("common.optional") }})</span></label>
          <input v-model="codeForm.note" maxlength="200" class="form-input" />
        </div>
        <button class="btn-primary" :disabled="codeCreating" @click="createCode">
          {{ codeCreating ? t("common.loading") : t("users.invites.createSubmit") }}
        </button>
        <div v-if="createdCode" class="invite-created">
          <span class="mono-label">{{ t("users.invites.createdCode") }}</span>
          <code class="invite-code">{{ createdCode }}</code>
          <button class="btn-secondary btn-sm" @click="copyCode(createdCode)">{{ t("common.copy") }}</button>
        </div>
      </div>

      <div v-if="codesLoading" class="empty-state">{{ t("common.loading") }}</div>
      <div v-else-if="!codes.length" class="empty-state">{{ t("users.invites.empty") }}</div>
      <div v-else class="table-wrap" style="--grid-cols: 1.4fr 1.4fr 0.6fr 1fr 0.8fr auto">
        <div class="table-header">
          <span>{{ t("users.invites.colCode") }}</span>
          <span>{{ t("users.invites.colKind") }}</span>
          <span>{{ t("users.invites.colUses") }}</span>
          <span>{{ t("users.invites.colNote") }}</span>
          <span>{{ t("users.invites.colStatus") }}</span>
          <span>{{ t("users.colActions") }}</span>
        </div>
        <div v-for="c in codes" :key="c.code" class="table-row">
          <span class="invite-code-cell">
            <code class="invite-code">{{ c.code }}</code>
            <button class="btn-icon" :title="t('common.copy')" @click="copyCode(c.code)"><Icon name="copy" /></button>
          </span>
          <span class="invite-kind">{{ codeKindSummary(c) }}</span>
          <span>{{ c.usedCount }}/{{ c.maxUses }}</span>
          <span class="invite-note">{{ c.note || "—" }}</span>
          <span><span :class="['status-badge', codeStatus(c).cls]">{{ codeStatus(c).text }}</span></span>
          <span class="row-actions">
            <button v-if="!c.revoked" class="btn-danger btn-sm" @click="revokeCode(c.code)">{{ t("users.invites.revoke") }}</button>
          </span>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>

    <div v-else class="table-wrap" style="--grid-cols: 56px 1.4fr 0.9fr 0.9fr 1.2fr auto">
      <div class="table-header">
        <span></span>
        <span>{{ t("users.colUsername") }}</span><span>{{ t("users.colLevel") }}</span><span>{{ t("users.colStatus") }}</span><span>{{ t("users.colActivation") }}</span><span>{{ t("users.colActions") }}</span>
      </div>
      <div v-for="u in users" :key="u.username" class="table-row">
        <span class="avatar-cell">
          <span class="avatar-fallback">{{ u.username.slice(0, 1).toUpperCase() }}</span>
          <img v-if="u.hasAvatar" :src="avatarSrc(u.username)" :alt="u.username" class="avatar-img" @error="onAvatarError" />
        </span>
        <span class="user-name">{{ u.username }}</span>
        <span>
          <select v-if="isSuperAdmin" :value="u.level" @change="changeLevel(u, parseInt(($event.target as HTMLSelectElement).value))" class="form-select level-select">
            <option :value="3">{{ t("users.levels.super") }}</option><option :value="2">{{ t("users.levels.admin") }}</option><option :value="1">{{ t("users.levels.user") }}</option><option :value="0">{{ t("users.levels.guest") }}</option>
          </select>
          <span v-else :class="['status-badge', levelColors[u.level] || 'info']">{{ levelKeys[u.level] ? t(`users.levels.${levelKeys[u.level]}`) : u.level }}</span>
        </span>
        <span>
          <span :class="['status-badge', u.enabled ? 'success' : 'error']" style="cursor:pointer" @click="toggleEnabled(u)">{{ u.enabled ? t("users.active") : t("users.disabled") }}</span>
        </span>
        <span>
          <template v-if="activationCell(u)">
            <span
              :class="['status-badge', activationCell(u)!.cls]"
              :style="canEditActivation(u) ? 'cursor:pointer' : ''"
              :title="canEditActivation(u) ? t('users.activation.edit') : ''"
              @click="canEditActivation(u) && openActModal(u)"
            >{{ activationCell(u)!.text }}</span>
          </template>
          <span v-else class="act-none">—</span>
        </span>
        <span class="row-actions">
          <button v-if="canEditAvatar(u)" class="btn-secondary btn-sm" :title="t('users.avatar.open')" @click="openAvatarModal(u)">{{ t("users.avatar.title") }}</button>
          <button v-if="isAdmin" class="btn-danger btn-sm" @click="deleteUser(u.username)">{{ t("common.delete") }}</button>
        </span>
      </div>
      <div v-if="!users.length" class="empty-state">{{ t("users.noUsers") }}</div>
    </div>

    <div v-if="showAvatarModal" class="modal-backdrop" @click.self="closeAvatarModal">
      <div class="card avatar-modal">
        <div class="card-header">
          <span class="card-title">{{ t("users.avatar.title") }} — {{ avatarTarget?.username }}</span>
          <button class="btn-icon" :aria-label="t('common.close')" @click="closeAvatarModal"><Icon name="cross" /></button>
        </div>
        <div class="avatar-modal-body">
          <div class="avatar-preview-wrap">
            <div class="mono-label">{{ t("users.avatar.current") }}</div>
            <div class="avatar-preview-current">
              <span class="avatar-fallback avatar-fallback-lg">{{ avatarTarget?.username.slice(0, 1).toUpperCase() }}</span>
              <img v-if="avatarTarget && users.find(u => u.username === avatarTarget!.username)?.hasAvatar" :src="avatarSrc(avatarTarget.username)" :alt="avatarTarget.username" class="avatar-img-lg" @error="onAvatarError" />
            </div>
          </div>
          <div class="avatar-preview-wrap" v-if="avatarPreview">
            <div class="mono-label">{{ t("users.avatar.change") }}</div>
            <img :src="avatarPreview" class="avatar-img-lg" alt="preview" />
          </div>
        </div>
        <div class="avatar-modal-actions">
          <label class="btn-secondary file-label">
            <input type="file" accept="image/jpeg,image/png,image/*" style="display:none" @change="onAvatarFileChange" />
            {{ t("users.avatar.upload") }}
          </label>
          <button v-if="avatarPreview" class="btn-secondary" @click="clearAvatarSelection">{{ t("users.avatar.clear") }}</button>
          <button class="btn-primary" :disabled="!canSubmitAvatar" @click="submitAvatar">
            {{ avatarUploading ? t("common.loading") : t("users.avatar.change") }}
          </button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <div v-if="showActModal && actTarget" class="modal-backdrop" @click.self="closeActModal">
      <div class="card act-modal">
        <div class="card-header">
          <span class="card-title">{{ t("users.activation.title") }} — {{ actTarget.username }}</span>
          <button class="btn-icon" :aria-label="t('common.close')" @click="closeActModal"><Icon name="cross" /></button>
        </div>
        <div class="act-modal-body">
          <div class="form-group">
            <label class="form-label">{{ t("users.activation.mode") }}</label>
            <div class="seg">
              <button type="button" :class="['seg-btn', { active: actMode === 'permanent' }]" @click="actMode = 'permanent'">{{ t("users.activation.modePermanent") }}</button>
              <button type="button" :class="['seg-btn', { active: actMode === 'until' }]" @click="actMode = 'until'">{{ t("users.activation.modeUntil") }}</button>
              <button type="button" :class="['seg-btn', { active: actMode === 'disabled' }]" @click="actMode = 'disabled'">{{ t("users.activation.modeDisabled") }}</button>
            </div>
          </div>
          <div v-if="actMode === 'until'" class="form-group">
            <label class="form-label">{{ t("users.activation.untilLabel") }}</label>
            <input v-model="actUntilInput" type="datetime-local" class="form-input" />
          </div>
          <div class="act-danger">
            <div class="form-label">{{ t("users.activation.dangerZone") }}</div>
            <div class="act-danger-row">
              <button class="btn-danger btn-sm" :disabled="!!actActionBusy" @click="freezeTarget">{{ t("users.activation.freeze") }}</button>
              <button class="btn-danger btn-sm" :disabled="!!actActionBusy" @click="revokeTarget('revokeSessions')">{{ t("users.activation.revokeSessions") }}</button>
              <button class="btn-danger btn-sm" :disabled="!!actActionBusy" @click="revokeTarget('revokeCredentials')">{{ t("users.activation.revokeCredentials") }}</button>
            </div>
          </div>
        </div>
        <div class="act-modal-actions">
          <button class="btn-secondary" @click="closeActModal">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="actSaving || (actMode === 'until' && !actUntilInput)" @click="saveActivation">
            {{ actSaving ? t("common.loading") : t("common.save") }}
          </button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.user-name { font-family: var(--font-mono); font-weight: 600; font-size: var(--fs-sm); color: var(--color-text-primary); letter-spacing: 0.05em; }
.level-select { display: inline-block; width: auto; padding: 0.25rem 0.5rem; font-size: var(--fs-sm); }

.avatar-cell {
  position: relative;
  width: 36px;
  height: 36px;
  display: inline-block;
}
.avatar-img {
  position: absolute;
  inset: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--color-border, rgba(0,0,0,0.1));
  background: var(--color-surface, #fff);
}
.avatar-fallback {
  position: absolute;
  inset: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-surface-2, #ececec);
  color: var(--color-text-muted, #888);
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: var(--fs-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.row-actions {
  display: inline-flex;
  gap: 0.4rem;
  justify-content: flex-end;
}

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.avatar-modal {
  position: relative;
  width: min(520px, 92vw);
  padding: 1.25rem;
}
.avatar-modal-body {
  display: flex;
  gap: 1.25rem;
  margin: 0.75rem 0 1rem;
  flex-wrap: wrap;
}
.avatar-preview-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.avatar-preview-current {
  position: relative;
  width: 120px;
  height: 120px;
}
.avatar-img-lg {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  object-fit: cover;
  border: 1px solid var(--color-border, rgba(0,0,0,0.1));
  background: var(--color-surface, #fff);
  position: relative;
}
.avatar-preview-current .avatar-img-lg {
  position: absolute;
  inset: 0;
}
.avatar-fallback-lg {
  position: absolute;
  inset: 0;
  width: 120px;
  height: 120px;
  border-radius: 8px;
  font-size: 3rem;
  background: var(--color-surface-2, #ececec);
  color: var(--color-text-muted, #888);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
}
.avatar-modal-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.file-label { cursor: pointer; }
.btn-icon {
  background: transparent;
  border: none;
  font-size: 1.2rem;
  cursor: pointer;
  padding: 0 0.4rem;
  color: var(--color-text-muted, #888);
}
.btn-icon:hover { color: var(--color-text-primary, #111); }

/* Header buttons */
.header-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }

/* Activation column / modal */
.act-none { color: var(--color-text-muted); }
.act-modal { position: relative; width: min(480px, 92vw); padding: 1.25rem; }
.act-modal-body { display: flex; flex-direction: column; gap: 0.9rem; margin: 0.75rem 0 1rem; }
.act-modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
.act-danger { border-top: 1px solid var(--color-border-subtle); padding-top: 0.8rem; }
.act-danger-row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.4rem; }

/* Invite codes */
.invites-card { position: relative; margin-bottom: 1.25rem; }
.invite-form { display: flex; flex-direction: column; gap: 0.8rem; max-width: 460px; margin-bottom: 1rem; }
.invite-num { max-width: 140px; }
.invite-code { font-family: var(--font-mono); letter-spacing: 0.06em; color: var(--color-accent-primary); }
.invite-code-cell { display: inline-flex; align-items: center; gap: 0.3rem; overflow: hidden; }
.invite-kind, .invite-note {
  font-size: var(--fs-sm); color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.invite-created {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  border: 1px solid var(--color-status-success);
  box-shadow: inset 3px 0 var(--color-status-success);
  padding: 0.6rem 0.8rem;
}
</style>
