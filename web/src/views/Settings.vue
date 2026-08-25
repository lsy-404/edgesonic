
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, formatSize } from "../api";
import { activationDisplay, mapActivationError } from "../lib/activation";
import { setLocale, SUPPORTED_LOCALES, type AppLocale } from "../i18n";
import { setTheme, activeTheme, SUPPORTED_THEMES, type AppTheme } from "../theme";
import { ensureBuiltinThemeLoaded } from "../themes/builtin";
import { getTheme, registeredThemeIds, externalThemeIds, loadExternalTheme, unregisterExternalTheme } from "../themes/registry";
import { audioCacheStats, clearAudioCache, audioCacheMaxMb, setAudioCacheMaxMb } from "../lib/audioCache";
import PermissionsMatrix from "../components/PermissionsMatrix.vue";
import Icon from "../components/Icon.vue";
import { useWorkSocket } from "../stores/workSocket";
import {
  buildReleaseOptions,
  GITHUB_API,
  parseSemver,
  ZERO_VERSION,
  type GithubRelease,
  type ReleaseListing,
} from "../../../shared/autoupdate";
import { defaultAvatarSvg } from "../../../shared/avatar";

const router = useRouter();
const route = useRoute();
const { t, locale } = useI18n();
const {
  isSuperAdmin, isGuest, hasPerm, edgesonicFetch, edgesonicPost, logout,
  username, nickname, avatarKey, email, emailVerified, restUrl,
  updateNickname, requestEmailChange, changeOwnPassword, updateOwnAvatar, handleAuthError,
  activation, fetchActivationStatus, redeemActivationCode,
} = useAuth();
const workPool = useWorkSocket();

// Release listing runs in the browser: GitHub's unauthenticated API budget is
// per source IP, and the Worker's is a Cloudflare egress address shared with
// unrelated tenants, so server-side lookups get 403'd on a spent limit. The
// Worker endpoint stays as the fallback for browsers that can't reach GitHub.
// The list is display-only — running an update still posts just a tag, which
// the Worker re-resolves and verifies itself.
async function githubReleaseListing(): Promise<CfUpdates | null> {
  try {
    const response = await fetch(`${GITHUB_API}/releases?per_page=50`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const releases = await response.json() as GithubRelease[];
    return buildReleaseOptions(releases, parseSemver(__EDGESONIC_VERSION__) || ZERO_VERSION);
  } catch {
    return null;
  }
}

// Advanced/system settings gate. Defaults to super-admin only (manage_settings
// is seeded L3=1), but a super-admin can grant it to an admin via the
// Permissions UI — the whole System section keys off this.
const canManageSettings = computed(() => hasPerm("manage_settings"));

// ---- Self-service profile (avatar / nickname / password), non-guest ----
const profileBusy = ref(false);
const nicknameInput = ref(nickname.value);
// Two-step email change — form fields for the request step, plus a
// pending flag so the UI can show "check your new inbox" instead of
// silently reverting to the (unchanged) current address.
const emailChangeOpen = ref(false);
const emailChangeCurrentPassword = ref("");
const emailChangeNewEmail = ref("");
const emailChangePending = ref(false);
const pwNew = ref("");
const pwConfirm = ref("");
const avatarBust = ref(0);
const avatarPreview = ref("");
const avatarBase64 = ref("");
const avatarMime = ref("image/jpeg");
const selfAvatarSrc = computed(() => avatarKey.value
  ? restUrl("getAvatar", { username: username.value, ...(avatarBust.value ? { _ts: String(avatarBust.value) } : {}) })
  // No upload yet: draw the same generated avatar the server would serve,
  // inline, so the slot is never an empty image.
  : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(defaultAvatarSvg(username.value))}`);

async function compressAvatar(file: File): Promise<{ dataUrl: string; base64: string; mime: string }> {
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("decode failed"));
      i.src = blobUrl;
    });
    const longEdge = 200;
    const scale = Math.min(1, longEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const MAX_BYTES = 100 * 1024;
    let quality = 0.85;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    const estimate = (s: string) => Math.floor((s.length - s.indexOf(",") - 1) * 3 / 4);
    while (estimate(dataUrl) > MAX_BYTES && quality > 0.4) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(",") + 1), mime: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function onSelfAvatarChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!/^image\//.test(file.type)) { showToast(t("settings.account.avatarInvalid"), "error"); return; }
  try {
    const { dataUrl, base64, mime } = await compressAvatar(file);
    avatarPreview.value = dataUrl; avatarBase64.value = base64; avatarMime.value = mime;
  } catch { showToast(t("settings.account.avatarFailed"), "error"); }
}

async function saveSelfAvatar() {
  if (!avatarBase64.value || profileBusy.value) return;
  profileBusy.value = true;
  try {
    await updateOwnAvatar(avatarBase64.value, avatarMime.value);
    avatarBust.value = Date.now();
    avatarPreview.value = ""; avatarBase64.value = "";
    showToast(t("settings.account.avatarSaved"));
  } catch { showToast(t("settings.account.avatarFailed"), "error"); }
  finally { profileBusy.value = false; }
}

async function saveNickname() {
  if (profileBusy.value) return;
  profileBusy.value = true;
  try {
    await updateNickname(nicknameInput.value);
    showToast(t("settings.account.nicknameSaved"));
  } catch { showToast(t("settings.account.nicknameFailed"), "error"); }
  finally { profileBusy.value = false; }
}

async function submitEmailChangeRequest() {
  if (profileBusy.value || !emailChangeCurrentPassword.value || !emailChangeNewEmail.value) return;
  profileBusy.value = true;
  try {
    const result = await requestEmailChange(emailChangeCurrentPassword.value, emailChangeNewEmail.value);
    if (!result.ok) throw new Error(result.error || "request failed");
    emailChangePending.value = true;
    emailChangeCurrentPassword.value = "";
    showToast(t("settings.account.emailChangeRequested"));
  } catch (e: unknown) {
    showToast(`${t("settings.account.emailFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  finally { profileBusy.value = false; }
}

function cancelEmailChange() {
  emailChangeOpen.value = false;
  emailChangePending.value = false;
  emailChangeCurrentPassword.value = "";
  emailChangeNewEmail.value = "";
}

async function saveSelfPassword() {
  if (profileBusy.value) return;
  if (!pwNew.value || pwNew.value.length < 4) { showToast(t("settings.account.passwordTooShort"), "error"); return; }
  if (pwNew.value !== pwConfirm.value) { showToast(t("settings.account.passwordMismatch"), "error"); return; }
  profileBusy.value = true;
  try {
    await changeOwnPassword(pwNew.value);
    pwNew.value = ""; pwConfirm.value = "";
    showToast(t("settings.account.passwordSaved"));
  } catch { showToast(t("settings.account.passwordFailed"), "error"); }
  finally { profileBusy.value = false; }
}

// ---- Peer sync moved to Tools.vue ----

type SectionKey = "user" | "activation" | "audioCache" | "system" | "sessions" | "clients" | "permissions";
const open = ref<Record<SectionKey, boolean>>({ user: true, activation: false, audioCache: false, system: false, sessions: false, clients: false, permissions: false });
function toggleSection(key: SectionKey) { open.value[key] = !open.value[key]; }
// The expired-activation banner deep-links here with ?section=activation.
if (route.query.section === "activation") { open.value.user = false; open.value.activation = true; }
// Nothing to redeem or read while the account is unbounded, so the section
// only appears once activation actually constrains it.
const showActivationSection = computed(() =>
  !isGuest.value && activation.value.enabled && activation.value.status !== "permanent");

type SubSectionKey = "media" | "integrations" | "lastfm" | "email" | "workers" | "featureFlags";
const subOpen = ref<Record<SubSectionKey, boolean>>({ media: false, integrations: false, lastfm: false, email: false, workers: false, featureFlags: false });
function toggleSubSection(key: SubSectionKey) { subOpen.value[key] = !subOpen.value[key]; }

const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

// ---- Account activation (status + redeem-anytime) ----
const actCode = ref("");
const actBusy = ref(false);
const actDisplay = computed(() => activationDisplay(activation.value.status, activation.value.until));
const actUntilText = computed(() => activation.value.until
  ? new Date(activation.value.until * 1000).toLocaleString(locale.value)
  : "");
const actBadgeClass = computed(() => ({
  permanent: "success", until: "info", expired: "error", disabled: "error",
}[actDisplay.value]));
const actStatusText = computed(() => actDisplay.value === "until"
  ? t("activation.state.until", { date: actUntilText.value })
  : t(`activation.state.${actDisplay.value}`));
onMounted(() => { if (!isGuest.value) void fetchActivationStatus(); });

async function redeemActivation() {
  if (actBusy.value || !actCode.value.trim()) return;
  actBusy.value = true;
  try {
    const result = await redeemActivationCode(actCode.value.trim());
    if (result.ok) {
      actCode.value = "";
      showToast(t("activation.redeemSuccess"));
    } else {
      const key = result.error ? mapActivationError(result.error) : null;
      showToast(key ? t(key) : (result.error || t("activation.redeemFailed")), "error");
    }
  } finally { actBusy.value = false; }
}

// ---- Browser audio cache (IndexedDB) ----
const cacheStats = ref<{ count: number; bytes: number } | null>(null);
const cacheCapMb = ref(audioCacheMaxMb());
const cacheBusy = ref(false);
const cacheUsagePct = computed(() => {
  if (!cacheStats.value) return 0;
  const cap = cacheCapMb.value * 1024 * 1024;
  return Math.min(100, Math.round((cacheStats.value.bytes / cap) * 100));
});
async function refreshCacheStats() {
  cacheStats.value = await audioCacheStats();
}
async function onCacheCapChange() {
  setAudioCacheMaxMb(cacheCapMb.value);
  await refreshCacheStats();
}
async function onClearCache() {
  if (cacheBusy.value) return;
  cacheBusy.value = true;
  const ok = await clearAudioCache();
  cacheBusy.value = false;
  await refreshCacheStats();
  showToast(t(ok ? "settings.audioCache.cleared" : "settings.audioCache.clearFailed"), ok ? "success" : "error");
}
onMounted(() => { void refreshCacheStats(); });

const localeLabels: Record<AppLocale, string> = { "zh-CN": "中文（简体）", en: "English" };
function onLocaleChange(e: Event) {
  setLocale((e.target as HTMLSelectElement).value as AppLocale);
}

function onThemeChange(next: AppTheme) {
  setTheme(next);
}

const pickerThemeIds = computed(() => {
  const known = new Set<string>(SUPPORTED_THEMES);
  const extra = registeredThemeIds().filter((id) => !known.has(id));
  return [...SUPPORTED_THEMES, ...extra];
});
function themeSwatchStyle(id: string): Record<string, string> {
  const visuals: Record<string, [string, string]> = {
    black: ["#0a0a0b", "#727784"], white: ["#f7f8fc", "#384d7a"],
    "color-gold": ["#080a18", "#d7ae37"], "sp-gold": ["#080a18", "#ffd64a"],
    "color-ocean": ["#f7fcff", "#65c7ec"], "sp-ocean": ["#f7fcff", "#65c7ec"],
    "color-scarlet": ["#fffafb", "#ff4004"], "sp-scarlet": ["#fffafb", "#ff4004"],
    "color-sky": ["#f8fffa", "#65bd8c"], "sp-sky": ["#f8fffa", "#65bd8c"],
    "color-earth": ["#fff9e8", "#ffc45a"], "sp-earth": ["#fff9e8", "#ffc45a"],
    "color-crimson": ["#25183e", "#9b78e5"], "sp-crimson": ["#25183e", "#9b78e5"],
    "sp-ark": ["#080a0b", "#18d1ff"], "sp-end": ["#191919", "#fffa00"],
  };
  const [base, accent] = visuals[id] ?? ["#111", "#fff"];
  const isNeutral = id === "black" || id === "white";
  return { "--swatch-base": base, "--swatch-accent": accent, background: isNeutral ? base : `linear-gradient(135deg, ${accent} 0 42%, color-mix(in srgb, ${accent} 50%, ${base}) 50%, ${base} 58% 100%)` };
}
function themeShape(id: string): string {
  if (id.includes("crimson")) return "dodecahedron";
  if (id.includes("gold")) return "star";
  if (id.includes("ocean")) return "icosahedron";
  if (id.includes("scarlet")) return "tetrahedron";
  if (id.includes("sky")) return "octahedron";
  if (id.includes("earth")) return "cube";
  if (id.includes("ark")) return "cube";
  if (id.includes("end")) return "icosahedron";
  return "cube";
}
onMounted(() => {
  // Warm every built-in theme's module so the picker's swatches/titles are
  // ready without waiting on a click.
  for (const id of SUPPORTED_THEMES) void ensureBuiltinThemeLoaded(id);
});

const externalThemeUrl = ref("");
const externalThemeBusy = ref(false);
const loadedExternalThemeIds = computed(() => externalThemeIds());
async function addExternalTheme() {
  const url = externalThemeUrl.value.trim();
  if (!url) return;
  externalThemeBusy.value = true;
  try {
    const def = await loadExternalTheme(url);
    externalThemeUrl.value = "";
    showToast(t("settings.common.externalTheme.loaded", { id: def.id }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`${t("settings.common.externalTheme.loadFailed")}: ${msg}`, "error");
  } finally {
    externalThemeBusy.value = false;
  }
}
function removeExternalTheme(id: string) {
  if (activeTheme.value === id) setTheme("black");
  unregisterExternalTheme(id);
}

interface Feature { key: string; value: number; description: string; }
interface FeatureString { key: string; value: string; description: string; }
const features = ref<Feature[]>([]);
const featureStrings = ref<FeatureString[]>([]);
const instanceId = ref("");
const loading = ref(true);
const error = ref("");
const copied = ref(false);

const transcodeEngine = ref<"sandbox" | "external" | "browser_pool" | "disabled">("disabled");
const sandboxIdleTimeout = ref<"15" | "150" | "300">("150");
const externalUrl = ref("");
const externalKeyInput = ref("");
const externalKeySet = ref(false);
const transcodeBusy = ref(false);

function findFeatureString(key: string, fallback: string): string {
  return featureStrings.value.find((f) => f.key === key)?.value ?? fallback;
}

async function loadFeatures() {
  loading.value = true;
  error.value = "";
  try {
    const text = await edgesonicFetch("features/list");
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "Request rejected");
    instanceId.value = data.instanceId || "";
    features.value = (data.features || []).map((f: Partial<Feature>) => ({
      key: f.key || "", value: Number(f.value) || 0, description: f.description || "",
    }));
    featureStrings.value = (data.featureStrings || []).map((f: Partial<FeatureString>) => ({
      key: f.key || "", value: typeof f.value === "string" ? f.value : "", description: f.description || "",
    }));
    // Hydrate transcode form from featureStrings.
    transcodeEngine.value = (findFeatureString("transcode_engine", "disabled") as "sandbox" | "external" | "browser_pool" | "disabled");
    const configuredIdleTimeout = findFeatureString("sandbox_idle_timeout_seconds", "150");
    sandboxIdleTimeout.value = configuredIdleTimeout === "15" || configuredIdleTimeout === "300" ? configuredIdleTimeout : "150";
    externalUrl.value = findFeatureString("external_transcoder_url", "");
    // Probe the secret presence (the value itself never crosses the wire).
    try {
      const probe = JSON.parse(await edgesonicFetch("features/secrets/get"));
      externalKeySet.value = !!probe?.set;
    } catch { externalKeySet.value = false; }
    // Hydrate the scrape source priority list from feature_strings.
    hydrateScrapeFromFeatures();
    // Hydrate Last.fm key presence indicator.
    void hydrateLastfmFromUserSetting();
    if (canManageSettings.value) {
      void hydrateLastfmSystem();
    }
    // Hydrate WebDAV scan cadence + BROWSER READ controls.
    hydrateScanFromFeatures();
    // Hydrate cross-origin isolation toggle.
    hydrateCioFromFeatures();
    // Hydrate presign toggles + probe R2 secrets presence.
    hydratePresignFromFeatures();
    loadR2PresignStatus();
    // Hydrate Resend config + login page customization, probe key presence.
    hydrateEmailFromFeatures();
    loadResendKeyStatus();
    // Hydrate the metadata re-check cadence.
    hydrateMetadataRecheckFromFeatures();
    // Hydrate the LRC sidecar backfill cadence.
    hydrateLrcBackfillFromFeatures();
    // Hydrate the registration gate mode for the activation controls.
    gateMode.value = findFeatureString("registration_gate_mode", "all") === "any" ? "any" : "all";
  } catch (e: unknown) {
    // 后端契约可能尚未部署 —— 优雅降级显示错误（非 JSON 响应一律视为 API 不可用）
    error.value = e instanceof SyntaxError || !(e instanceof Error)
      ? t("settings.common.apiUnavailable")
      : e.message;
    features.value = [];
    featureStrings.value = [];
  }
  loading.value = false;
}

async function saveTranscode() {
  transcodeBusy.value = true;
  try {
    // updateFeatureString validates server-side; we batch calls for one
    // user-visible "Save" click. Optimistic update — fail at the first error.
    const writes = [
      { key: "transcode_engine", value: transcodeEngine.value },
      { key: "sandbox_idle_timeout_seconds", value: sandboxIdleTimeout.value },
      { key: "external_transcoder_url", value: externalUrl.value },
    ];
    for (const w of writes) {
      const data = JSON.parse(await edgesonicPost("features/updateString", w));
      if (!data.ok) throw new Error(data.error || w.key);
    }
    // External key is opaque — only POST when the input is non-empty.
    if (externalKeyInput.value) {
      const data = JSON.parse(await edgesonicPost("features/secrets/set", { value: externalKeyInput.value }));
      if (!data.ok) throw new Error(data.error || "external_key");
      externalKeySet.value = true;
      externalKeyInput.value = "";
    }
    showToast(t("settings.common.transcode.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.transcode.saveFailed")}: ${msg}`, "error");
  }
  transcodeBusy.value = false;
}

type ScrapeSourceKey = "lrc" | "netease" | "qmusic" | "kugou" | "kuwo" | "migu";
const SCRAPE_ALL_SOURCES: { id: ScrapeSourceKey; label: string }[] = [
  { id: "lrc", label: "LRC Albums" },
  { id: "netease", label: "NetEase" },
  { id: "qmusic", label: "QQ Music" },
  { id: "kugou", label: "Kugou" },
  { id: "kuwo", label: "Kuwo (preview)" },
  { id: "migu", label: "Migu (preview)" },
];
const scrapeOrder = ref<ScrapeSourceKey[]>([]);
const scrapeEnabledSet = ref<Set<ScrapeSourceKey>>(new Set());
const scrapeBusy = ref(false);

function hydrateScrapeFromFeatures() {
  // Order = whatever the JSON array stored; we render it in that order and
  // any source NOT in the array gets appended (disabled) so the UI shows all.
  try {
    const raw = findFeatureString("scrape_enabled_sources", '["lrc","netease","qmusic","kugou"]');
    const parsed = JSON.parse(raw) as string[];
    const validEnabled: ScrapeSourceKey[] = [];
    const knownIds = new Set(SCRAPE_ALL_SOURCES.map((s) => s.id));
    for (const s of parsed) {
      if (knownIds.has(s as ScrapeSourceKey)) validEnabled.push(s as ScrapeSourceKey);
    }
    scrapeEnabledSet.value = new Set(validEnabled);
    const orderTail = SCRAPE_ALL_SOURCES
      .map((s) => s.id)
      .filter((id) => !validEnabled.includes(id));
    scrapeOrder.value = [...validEnabled, ...orderTail];
  } catch {
    scrapeOrder.value = SCRAPE_ALL_SOURCES.map((s) => s.id);
    scrapeEnabledSet.value = new Set(["lrc", "netease", "qmusic", "kugou"]);
  }
}

function toggleScrapeSource(id: ScrapeSourceKey, checked: boolean) {
  const next = new Set(scrapeEnabledSet.value);
  if (checked) next.add(id); else next.delete(id);
  scrapeEnabledSet.value = next;
}

function moveScrapeSource(id: ScrapeSourceKey, delta: -1 | 1) {
  const arr = [...scrapeOrder.value];
  const i = arr.indexOf(id);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  scrapeOrder.value = arr;
}

async function saveScrape() {
  scrapeBusy.value = true;
  try {
    // Persist only the enabled subset in the user-chosen priority order.
    const enabledInOrder = scrapeOrder.value.filter((id) => scrapeEnabledSet.value.has(id));
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "scrape_enabled_sources",
      value: JSON.stringify(enabledInOrder),
    }));
    if (!data.ok) throw new Error(data.error || "scrape_enabled_sources");
    showToast(t("settings.common.scrape.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.scrape.saveFailed")}: ${msg}`, "error");
  }
  scrapeBusy.value = false;
}

// ---- Last.fm (per-user: username + per-user API key) ----
const lastfmUsernameInput = ref("");
const lastfmUsernameSet = ref(false);
const lastfmApiKeyInput = ref("");
const lastfmApiKeySet = ref(false);
const lastfmBusy = ref(false);

async function hydrateLastfmFromUserSetting() {
  try {
    const data = JSON.parse(await edgesonicFetch("lastfm/status"));
    if (data.ok) {
      lastfmUsernameSet.value = !!data.usernameSet;
      lastfmApiKeySet.value = !!data.apiKeySet;
      lastfmUsernameInput.value = data.username || "";
    }
  } catch { /* stay unset */ }
}

async function saveLastfmUsername() {
  lastfmBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("lastfm/username", {
      username: lastfmUsernameInput.value,
    }));
    if (!data.ok) throw new Error(data.error || "username");
    lastfmUsernameSet.value = !!lastfmUsernameInput.value;
    showToast(t("settings.common.lastfm.usernameSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  lastfmBusy.value = false;
}

async function clearLastfmUsername() {
  lastfmBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("lastfm/username", { username: "" }));
    if (!data.ok) throw new Error(data.error || "username");
    lastfmUsernameSet.value = false;
    lastfmUsernameInput.value = "";
    showToast(t("settings.common.lastfm.usernameCleared"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  lastfmBusy.value = false;
}

async function saveLastfmApiKey() {
  lastfmBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("lastfm/apiKey", {
      apiKey: lastfmApiKeyInput.value,
    }));
    if (!data.ok) throw new Error(data.error || "apiKey");
    lastfmApiKeySet.value = !!lastfmApiKeyInput.value;
    lastfmApiKeyInput.value = "";
    showToast(t("settings.common.lastfm.apiKeySaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  lastfmBusy.value = false;
}

async function clearLastfmApiKey() {
  lastfmBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("lastfm/apiKey", { apiKey: "" }));
    if (!data.ok) throw new Error(data.error || "apiKey");
    lastfmApiKeySet.value = false;
    lastfmApiKeyInput.value = "";
    showToast(t("settings.common.lastfm.apiKeyCleared"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  lastfmBusy.value = false;
}

// ---- Last.fm (system-level: api_key + artist info source order + cron cadence) ----
// last.fm is no longer hardcoded as the first artist bio/cover source —
// it's just another member of the same priority list as the CN sources,
// reorderable the same way scrape_enabled_sources is (see ScrapeSourceKey
// above). Defaults to CN sources ahead of last.fm.
type ArtistInfoSourceKey = "netease" | "qmusic" | "lastfm";
const ARTIST_INFO_ALL_SOURCES: { id: ArtistInfoSourceKey; label: string }[] = [
  { id: "netease", label: "NetEase" },
  { id: "qmusic", label: "QQ Music" },
  { id: "lastfm", label: "Last.fm" },
];
const artistInfoOrder = ref<ArtistInfoSourceKey[]>([]);
const artistInfoEnabledSet = ref<Set<ArtistInfoSourceKey>>(new Set());
const artistInfoBusy = ref(false);

const lastfmSystemKeyInput = ref("");
const lastfmSystemKeySet = ref(false);
const lastfmSystemBusy = ref(false);
const scrapeIntervalHours = ref(24);
const scrapeIntervalBusy = ref(false);

function hydrateArtistInfoSources(raw: string) {
  try {
    const parsed = JSON.parse(raw) as string[];
    const knownIds = new Set(ARTIST_INFO_ALL_SOURCES.map((s) => s.id));
    const validEnabled: ArtistInfoSourceKey[] = [];
    for (const s of parsed) {
      if (knownIds.has(s as ArtistInfoSourceKey)) validEnabled.push(s as ArtistInfoSourceKey);
    }
    artistInfoEnabledSet.value = new Set(validEnabled);
    const orderTail = ARTIST_INFO_ALL_SOURCES
      .map((s) => s.id)
      .filter((id) => !validEnabled.includes(id));
    artistInfoOrder.value = [...validEnabled, ...orderTail];
  } catch {
    artistInfoOrder.value = ARTIST_INFO_ALL_SOURCES.map((s) => s.id);
    artistInfoEnabledSet.value = new Set(["netease", "qmusic", "lastfm"]);
  }
}

function toggleArtistInfoSource(id: ArtistInfoSourceKey, checked: boolean) {
  const next = new Set(artistInfoEnabledSet.value);
  if (checked) next.add(id); else next.delete(id);
  artistInfoEnabledSet.value = next;
}

function moveArtistInfoSource(id: ArtistInfoSourceKey, delta: -1 | 1) {
  const arr = [...artistInfoOrder.value];
  const i = arr.indexOf(id);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  artistInfoOrder.value = arr;
}

async function saveArtistInfoSources() {
  artistInfoBusy.value = true;
  try {
    const enabledInOrder = artistInfoOrder.value.filter((id) => artistInfoEnabledSet.value.has(id));
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "lastfm_fallback_sources",
      value: JSON.stringify(enabledInOrder),
    }));
    if (!data.ok) throw new Error(data.error || "lastfm_fallback_sources");
    showToast(t("settings.common.lastfm.fallbackSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  artistInfoBusy.value = false;
}

async function hydrateLastfmSystem() {
  try {
    const keyRow = JSON.parse(await edgesonicFetch("features/list"));
    if (keyRow?.ok) {
      const item = (keyRow.featureStrings as Array<{ key: string; value: string }>)
        .find((s) => s.key === "lastfm_api_key");
      lastfmSystemKeySet.value = !!(item && item.value && item.value.length);
      const fb = (keyRow.featureStrings as Array<{ key: string; value: string }>)
        .find((s) => s.key === "lastfm_fallback_sources");
      hydrateArtistInfoSources(fb?.value || '["netease","qmusic","lastfm"]');
      const iv = (keyRow.featureStrings as Array<{ key: string; value: string }>)
        .find((s) => s.key === "artist_scrape_interval_hours");
      scrapeIntervalHours.value = iv ? Math.max(0, parseInt(iv.value, 10) || 0) : 0;
    }
  } catch { /* ignore */ }
  lastfmSystemKeyInput.value = "";
}

async function saveLastfmSystemKey() {
  lastfmSystemBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "lastfm_api_key",
      value: lastfmSystemKeyInput.value,
    }));
    if (!data.ok) throw new Error(data.error || "lastfm_api_key");
    lastfmSystemKeySet.value = !!lastfmSystemKeyInput.value;
    lastfmSystemKeyInput.value = "";
    showToast(t("settings.common.lastfm.systemKeySaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  lastfmSystemBusy.value = false;
}

async function clearLastfmSystemKey() {
  lastfmSystemBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "lastfm_api_key",
      value: "",
    }));
    if (!data.ok) throw new Error(data.error || "lastfm_api_key");
    lastfmSystemKeySet.value = false;
    lastfmSystemKeyInput.value = "";
    showToast(t("settings.common.lastfm.systemKeyCleared"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  lastfmSystemBusy.value = false;
}

async function saveScrapeInterval() {
  scrapeIntervalBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "artist_scrape_interval_hours",
      value: String(scrapeIntervalHours.value),
    }));
    if (!data.ok) throw new Error(data.error || "artist_scrape_interval_hours");
    showToast(t("settings.common.lastfm.scrapeIntervalSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  scrapeIntervalBusy.value = false;
}

const scanIntervalHours = ref<number>(1);
const scanEtagCheck = ref<boolean>(true);
const scanRescanStrategy = ref<"auto" | "worker" | "browser">("auto");
const scanBusy = ref(false);

const cioEnabled = ref<boolean>(true);
const cioBusy = ref(false);
const cioLive = computed<boolean>(() =>
  typeof window !== "undefined" &&
  (window as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
);

function hydrateCioFromFeatures() {
  cioEnabled.value = findFeatureString("enable_cross_origin_isolation", "1") !== "0";
}

async function saveCio() {
  cioBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "enable_cross_origin_isolation",
      value: cioEnabled.value ? "1" : "0",
    }));
    if (!data.ok) throw new Error(data.error || "enable_cross_origin_isolation");
    showToast(t("settings.common.crossOriginIsolation.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.crossOriginIsolation.saveFailed")}: ${msg}`, "error");
  }
  cioBusy.value = false;
}

const r2PresignEnabled = ref<boolean>(false);
const webdavPresignEnabled = ref<boolean>(true);
const r2SecretsConfigured = ref<boolean>(false);
const r2CredentialValid = ref<boolean | null>(null);
const r2PresignBusy = ref(false);
const webdavPresignBusy = ref(false);

function hydratePresignFromFeatures() {
  r2PresignEnabled.value = findFeatureString("enable_r2_presign", "0") === "1";
  webdavPresignEnabled.value = findFeatureString("enable_webdav_presign", "1") === "1";
}

async function loadR2PresignStatus() {
  if (!canManageSettings.value) return;
  try {
    const data = JSON.parse(await edgesonicFetch("r2presign/status"));
    if (data?.ok) {
      r2SecretsConfigured.value = !!data.secretsConfigured;
      r2CredentialValid.value = typeof data.credentialValid === "boolean" ? data.credentialValid : null;
    }
  } catch { /* status endpoint may be absent on older deploys — silent */ }
}

async function saveR2Presign() {
  r2PresignBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "enable_r2_presign",
      value: r2PresignEnabled.value ? "1" : "0",
    }));
    if (!data.ok) throw new Error(data.error || "enable_r2_presign");
    showToast(t("settings.common.presign.r2Saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.presign.saveFailed")}: ${msg}`, "error");
  }
  r2PresignBusy.value = false;
}

async function saveWebdavPresign() {
  webdavPresignBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "enable_webdav_presign",
      value: webdavPresignEnabled.value ? "1" : "0",
    }));
    if (!data.ok) throw new Error(data.error || "enable_webdav_presign");
    showToast(t("settings.common.presign.webdavSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.presign.saveFailed")}: ${msg}`, "error");
  }
  webdavPresignBusy.value = false;
}

// ---- Resend email integration + login page customization ----
const resendFromEmail = ref("");
const resendFromName = ref("");
const resendKeyInput = ref("");
const resendKeySet = ref(false);
const resendBusy = ref(false);
const resendTestEmail = ref("");
const resendTestBusy = ref(false);
const resendTestResult = ref("");
const loginNoticeText = ref("");
const loginBackgroundUrl = ref("");
const loginConfigBusy = ref(false);

// Email templates — super-admin only (enforced server-side too; see
// features.ts SUPER_ADMIN_ONLY_STRING_KEYS). Defaults come from D1 seeding,
// so these start non-empty on any deploy that has run Schema.sql.
const emailTplVerifySubject = ref("");
const emailTplVerifyBody = ref("");
const emailTplResetSubject = ref("");
const emailTplResetBody = ref("");
const emailTplChangeSubject = ref("");
const emailTplChangeBody = ref("");
const emailTplBusy = ref(false);

function hydrateEmailFromFeatures() {
  resendFromEmail.value = findFeatureString("resend_from_email", "");
  resendFromName.value = findFeatureString("resend_from_name", "EdgeSonic");
  loginNoticeText.value = findFeatureString("login_notice_text", "");
  loginBackgroundUrl.value = findFeatureString("login_background_url", "");
  emailTplVerifySubject.value = findFeatureString("email_tpl_verify_subject", "");
  emailTplVerifyBody.value = findFeatureString("email_tpl_verify_body", "");
  emailTplResetSubject.value = findFeatureString("email_tpl_reset_subject", "");
  emailTplResetBody.value = findFeatureString("email_tpl_reset_body", "");
  emailTplChangeSubject.value = findFeatureString("email_tpl_change_subject", "");
  emailTplChangeBody.value = findFeatureString("email_tpl_change_body", "");
}

async function saveEmailTemplate(kind: "verify" | "reset" | "change") {
  emailTplBusy.value = true;
  try {
    const subjectValue = { verify: emailTplVerifySubject, reset: emailTplResetSubject, change: emailTplChangeSubject }[kind].value;
    const bodyValue = { verify: emailTplVerifyBody, reset: emailTplResetBody, change: emailTplChangeBody }[kind].value;
    const r1 = JSON.parse(await edgesonicPost("features/updateString", { key: `email_tpl_${kind}_subject`, value: subjectValue }));
    if (!r1.ok) throw new Error(r1.error || `email_tpl_${kind}_subject`);
    const r2 = JSON.parse(await edgesonicPost("features/updateString", { key: `email_tpl_${kind}_body`, value: bodyValue }));
    if (!r2.ok) throw new Error(r2.error || `email_tpl_${kind}_body`);
    showToast(t("settings.common.email.templateSaved"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.email.saveFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  emailTplBusy.value = false;
}

async function loadResendKeyStatus() {
  if (!canManageSettings.value) return;
  try {
    const data = JSON.parse(await edgesonicFetch("features/secrets/get?key=resend_api_key"));
    if (data?.ok) resendKeySet.value = !!data.set;
  } catch { /* ignore — probe is best-effort */ }
}

async function saveResendKey() {
  resendBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/secrets/set", { key: "resend_api_key", value: resendKeyInput.value }));
    if (!data.ok) throw new Error(data.error || "resend_api_key");
    resendKeySet.value = !!resendKeyInput.value;
    resendKeyInput.value = "";
    showToast(t("settings.common.email.keySaved"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.email.saveFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  resendBusy.value = false;
}

async function clearResendKey() {
  resendBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/secrets/set", { key: "resend_api_key", value: "" }));
    if (!data.ok) throw new Error(data.error || "resend_api_key");
    resendKeySet.value = false;
    resendKeyInput.value = "";
    showToast(t("settings.common.email.keyCleared"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.email.saveFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  resendBusy.value = false;
}

async function saveResendFrom() {
  resendBusy.value = true;
  try {
    const r1 = JSON.parse(await edgesonicPost("features/updateString", { key: "resend_from_email", value: resendFromEmail.value }));
    if (!r1.ok) throw new Error(r1.error || "resend_from_email");
    const r2 = JSON.parse(await edgesonicPost("features/updateString", { key: "resend_from_name", value: resendFromName.value }));
    if (!r2.ok) throw new Error(r2.error || "resend_from_name");
    showToast(t("settings.common.email.fromSaved"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.email.saveFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  resendBusy.value = false;
}

async function sendResendTest() {
  if (!resendTestEmail.value || resendTestBusy.value) return;
  resendTestBusy.value = true;
  resendTestResult.value = "";
  try {
    const data = JSON.parse(await edgesonicPost("email/test", { to: resendTestEmail.value }));
    if (!data.ok) throw new Error(data.error || "send failed");
    resendTestResult.value = t("settings.common.email.testSent");
  } catch (e: unknown) {
    resendTestResult.value = `${t("settings.common.email.testFailed")}: ${e instanceof Error ? e.message : String(e)}`;
  }
  resendTestBusy.value = false;
}

async function saveLoginConfig() {
  loginConfigBusy.value = true;
  try {
    const r1 = JSON.parse(await edgesonicPost("features/updateString", { key: "login_notice_text", value: loginNoticeText.value }));
    if (!r1.ok) throw new Error(r1.error || "login_notice_text");
    const r2 = JSON.parse(await edgesonicPost("features/updateString", { key: "login_background_url", value: loginBackgroundUrl.value }));
    if (!r2.ok) throw new Error(r2.error || "login_background_url");
    showToast(t("settings.common.email.loginConfigSaved"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.email.saveFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  loginConfigBusy.value = false;
}

const metadataRecheckIntervalHours = ref<number>(24);
const metadataRecheckIntervalBusy = ref(false);

function hydrateMetadataRecheckFromFeatures() {
  const hours = parseInt(findFeatureString("metadata_recheck_interval_hours", "24"), 10);
  metadataRecheckIntervalHours.value = Number.isFinite(hours) && hours >= 0 ? hours : 24;
}

async function saveMetadataRecheckInterval() {
  metadataRecheckIntervalBusy.value = true;
  try {
    const hours = Math.max(0, Math.min(168, Math.floor(metadataRecheckIntervalHours.value || 0)));
    metadataRecheckIntervalHours.value = hours;
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "metadata_recheck_interval_hours",
      value: String(hours),
    }));
    if (!data.ok) throw new Error(data.error || "metadata_recheck_interval_hours");
    showToast(t("settings.common.workerPool.recheckIntervalSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.workerPool.recheckIntervalSaveFailed")}: ${msg}`, "error");
  }
  metadataRecheckIntervalBusy.value = false;
}

const lrcBackfillIntervalHours = ref<number>(24);
const lrcBackfillIntervalBusy = ref(false);

function hydrateLrcBackfillFromFeatures() {
  const hours = parseInt(findFeatureString("lrc_backfill_interval_hours", "24"), 10);
  lrcBackfillIntervalHours.value = Number.isFinite(hours) && hours >= 0 ? hours : 24;
}

async function saveLrcBackfillInterval() {
  lrcBackfillIntervalBusy.value = true;
  try {
    const hours = Math.max(0, Math.min(168, Math.floor(lrcBackfillIntervalHours.value || 0)));
    lrcBackfillIntervalHours.value = hours;
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "lrc_backfill_interval_hours",
      value: String(hours),
    }));
    if (!data.ok) throw new Error(data.error || "lrc_backfill_interval_hours");
    showToast(t("settings.common.workerPool.lrcBackfillIntervalSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.workerPool.lrcBackfillIntervalSaveFailed")}: ${msg}`, "error");
  }
  lrcBackfillIntervalBusy.value = false;
}

function hydrateScanFromFeatures() {
  const hours = parseInt(findFeatureString("scan_interval_hours", "1"), 10);
  scanIntervalHours.value = Number.isFinite(hours) && hours >= 0 ? hours : 1;
  scanEtagCheck.value = findFeatureString("scan_etag_check", "1") !== "0";
  const strat = findFeatureString("scan_rescan_strategy", "auto");
  scanRescanStrategy.value = (["auto", "worker", "browser"].includes(strat)
    ? strat
    : "auto") as "auto" | "worker" | "browser";
}

async function saveScan() {
  scanBusy.value = true;
  try {
    // Clamp hours just in case the input slips past the min/max — the worker
    // also validates but a friendly client-side guard avoids a round-trip.
    const hours = Math.max(0, Math.min(168, Math.floor(scanIntervalHours.value || 0)));
    scanIntervalHours.value = hours;
    const writes = [
      { key: "scan_interval_hours", value: String(hours) },
      { key: "scan_etag_check", value: scanEtagCheck.value ? "1" : "0" },
      { key: "scan_rescan_strategy", value: scanRescanStrategy.value },
    ];
    for (const w of writes) {
      const data = JSON.parse(await edgesonicPost("features/updateString", w));
      if (!data.ok) throw new Error(data.error || w.key);
    }
    showToast(t("settings.common.scan.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.scan.saveFailed")}: ${msg}`, "error");
  }
  scanBusy.value = false;
}

interface CfStatus {
  configured: boolean;
  accountId: string;
  tokenLast4: string;
}
interface CfAnalytics {
  available: boolean;
  requests?: number;
  errors?: number;
  errorRate?: number;
  cpuMs?: number;
  cpuP99Ms?: number;
  error?: string;
}
type CfUpdates = Omit<ReleaseListing, "ok">;
const cfStatus = ref<CfStatus>({ configured: false, accountId: "", tokenLast4: "" });
const cfAccountId = ref("");
const cfToken = ref("");
const cfBusy = ref(false);
const cfTestBusy = ref(false);
const cronExpression = ref("");
const cronBusy = ref(false);
const cfAnalytics = ref<CfAnalytics | null>(null);
const cfAnalyticsBusy = ref(false);
const cfEnsureCronBusy = ref(false);
const cfUpdates = ref<CfUpdates | null>(null);
const cfUpdateTag = ref("");
const cfUpdatesBusy = ref(false);
const cfUpdateBusy = ref(false);
const cfMajorConfirmed = ref(false);
const selectedCfUpdate = computed(() => cfUpdates.value?.releases.find((release) => release.tag === cfUpdateTag.value) || null);
const cfUpdateCanRun = computed(() => {
  const release = selectedCfUpdate.value;
  if (!release || !release.hasArtifact) return false;
  return (release.eligible || release.isMajor) && (!release.isMajor || cfMajorConfirmed.value);
});

function cfUpdateReasonKey(reason: string): string {
  switch (reason) {
    case "artifact-missing": return "noArtifact";
    case "not-newer": return "notNewer";
    case "downgrade": return "downgrade";
    case "major-confirmation-required": return "majorConfirmationRequired";
    case "invalid-version": return "invalidVersion";
    default: return "updateFailed";
  }
}

async function loadCfStatus() {
  if (!canManageSettings.value) return;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/getStatus")) as CfStatus & { ok: boolean };
    if (data.ok) {
      cfStatus.value = { configured: data.configured, accountId: data.accountId, tokenLast4: data.tokenLast4 };
      // Pre-fill the account ID input when one is on file so re-saving the
      // token doesn't require typing the account ID again.
      if (data.accountId && !cfAccountId.value) cfAccountId.value = data.accountId;
    }
  } catch { /* status is best-effort */ }
}

async function loadCfUpdates() {
  if (!hasPerm("manage_cloudflare")) return;
  cfUpdatesBusy.value = true;
  try {
    let listing = await githubReleaseListing();
    if (!listing) {
      const fallback = JSON.parse(await edgesonicFetch("cf/getUpdates")) as CfUpdates & { ok: boolean; error?: string };
      if (!fallback.ok) throw new Error(fallback.error || "getUpdates");
      listing = fallback;
    }
    cfUpdates.value = listing;
    if (!cfUpdateTag.value || !listing.releases.some((release) => release.tag === cfUpdateTag.value)) {
      cfUpdateTag.value = listing.defaultTag || listing.releases[0]?.tag || "";
    }
  } catch (e: unknown) {
    showToast(`${t("settings.common.cf.updateFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  cfUpdatesBusy.value = false;
}

async function runCfUpdate() {
  const release = selectedCfUpdate.value;
  if (!release || !cfUpdateCanRun.value || cfUpdateBusy.value) return;
  cfUpdateBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("cf/update", {
      tag: release.tag,
      confirmMajor: release.isMajor && cfMajorConfirmed.value,
    })) as { ok: boolean; version?: string; error?: string };
    if (!data.ok) throw new Error(data.error || "update");
    cfMajorConfirmed.value = false;
    showToast(t("settings.common.cf.updateSuccess", { ver: data.version || release.version }));
    await loadCfUpdates();
  } catch (e: unknown) {
    showToast(`${t("settings.common.cf.updateFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  cfUpdateBusy.value = false;
}

async function loadCfCron() {
  if (!canManageSettings.value) return;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/getCron")) as {
      ok: boolean;
      schedules?: Array<{ cron: string }>;
    };
    if (data.ok && Array.isArray(data.schedules)) {
      cronExpression.value = data.schedules.map((s) => s.cron).join("\n");
    }
  } catch { /* cron load failure is silent — the user can still type */ }
}

async function saveCfToken() {
  if (!cfToken.value.trim() || !cfAccountId.value.trim()) {
    showToast(t("settings.common.cf.saveFailed"), "error");
    return;
  }
  cfBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("cf/setToken", {
      accountId: cfAccountId.value.trim(),
      token: cfToken.value.trim(),
    })) as { ok: boolean; error?: string; tokenLast4?: string };
    if (!data.ok) throw new Error(data.error || "setToken");
    cfToken.value = "";
    showToast(t("settings.common.cf.saved"));
    // Wait a beat so env can refresh — getStatus reads from env, so we
    // immediately follow up to surface the new tokenLast4.
    await loadCfStatus();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.cf.saveFailed")}: ${msg}`, "error");
  }
  cfBusy.value = false;
}

async function testCfConn() {
  cfTestBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/testConn")) as {
      ok: boolean;
      error?: string;
      accountName?: string;
    };
    if (!data.ok) throw new Error(data.error || "testConn");
    showToast(t("settings.common.cf.testOk", { name: data.accountName || cfStatus.value.accountId }));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.cf.testFailed")}: ${msg}`, "error");
  }
  cfTestBusy.value = false;
}

async function saveCron() {
  cronBusy.value = true;
  try {
    const crons = cronExpression.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const data = JSON.parse(await edgesonicPost("cf/setCron", { crons })) as {
      ok: boolean;
      error?: string;
    };
    if (!data.ok) throw new Error(data.error || "setCron");
    showToast(t("settings.common.cf.cronSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.cf.cronSaveFailed")}: ${msg}`, "error");
  }
  cronBusy.value = false;
}

async function ensureDefaultCron() {
  cfEnsureCronBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/ensureDefaultCron")) as {
      ok: boolean;
      error?: string;
      applied?: boolean;
      schedules?: Array<{ cron: string }> | unknown;
    };
    if (!data.ok) throw new Error(data.error || "ensureDefaultCron");
    if (data.applied) {
      showToast(t("settings.common.cf.ensureCronApplied"));
      // Reflect the new cron in the editable textarea so the admin sees what's live.
      await loadCfCron();
    } else {
      showToast(t("settings.common.cf.ensureCronAlreadySet"));
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.cf.ensureCronFailed")}: ${msg}`, "error");
  }
  cfEnsureCronBusy.value = false;
}

async function loadCfAnalytics() {
  if (!canManageSettings.value) return;
  cfAnalyticsBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/getAnalytics")) as CfAnalytics & { ok: boolean };
    cfAnalytics.value = data;
  } catch (e: unknown) {
    cfAnalytics.value = {
      available: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  cfAnalyticsBusy.value = false;
}

const workerStatus = ref<{
  counts: Record<string, number>;
  load: Array<{ username: string; n: number }>;
  recent: Array<{
    id: string;
    task_type: string;
    status: string;
    claimed_by: string | null;
    attempts: number;
    max_attempts: number;
  }>;
} | null>(null);
const workerStatusLoading = ref(false);
const workerStatusError = ref("");

async function loadWorkerStatus() {
  if (!canManageSettings.value) return;
  workerStatusLoading.value = true;
  workerStatusError.value = "";
  try {
    const text = await edgesonicFetch("work/status");
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    workerStatus.value = {
      counts: data.counts || {},
      load: data.load || [],
      recent: data.recent || [],
    };
  } catch (e: unknown) {
    if (handleAuthError(e)) {
      showToast(t("common.sessionExpired"), "error");
      workerStatusError.value = t("common.sessionExpired");
      return;
    }
    workerStatusError.value = e instanceof Error ? e.message : String(e);
  }
  workerStatusLoading.value = false;
}

const workerBackfillBusy = ref(false);
const workerBackfillToast = ref("");
async function onBackfillCompleted() {
  if (!canManageSettings.value || workerBackfillBusy.value) return;
  workerBackfillBusy.value = true;
  workerBackfillToast.value = "";
  try {
    const text = await edgesonicPost("work/backfillCompleted", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    workerBackfillToast.value = t("settings.common.workerPool.backfillDoneToast", {
      applied: data.applied || 0,
      processed: data.processed || 0,
      failed: data.failed || 0,
    });
    await loadWorkerStatus();
  } catch (e: unknown) {
    workerBackfillToast.value = e instanceof Error ? e.message : String(e);
  }
  workerBackfillBusy.value = false;
}

const recheckMetadataBusy = ref(false);
const recheckMetadataToast = ref("");
async function onRecheckMetadataNow() {
  if (!canManageSettings.value || recheckMetadataBusy.value) return;
  recheckMetadataBusy.value = true;
  recheckMetadataToast.value = "";
  try {
    const text = await edgesonicPost("work/recheckMetadataNow", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    recheckMetadataToast.value = t("settings.common.workerPool.recheckDoneToast", {
      dispatched: data.dispatched || 0,
      unsupported: data.unsupportedFormat || 0,
      incomplete: data.lyricsOrDiscIncomplete || 0,
      badDuration: data.implausibleWavDuration || 0,
    });
    await loadWorkerStatus();
  } catch (e: unknown) {
    recheckMetadataToast.value = e instanceof Error ? e.message : String(e);
  }
  recheckMetadataBusy.value = false;
}

const backfillLrcBusy = ref(false);
const backfillLrcToast = ref("");
async function onBackfillLrcNow() {
  if (!canManageSettings.value || backfillLrcBusy.value) return;
  backfillLrcBusy.value = true;
  backfillLrcToast.value = "";
  try {
    const text = await edgesonicPost("work/backfillLrcNow", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    backfillLrcToast.value = t("settings.common.workerPool.lrcBackfillDoneToast", {
      filled: data.filled || 0,
      candidates: data.candidates || 0,
    });
  } catch (e: unknown) {
    backfillLrcToast.value = e instanceof Error ? e.message : String(e);
  }
  backfillLrcBusy.value = false;
}

const cleanupCoversBusy = ref(false);
const cleanupCoversToast = ref("");
async function onCleanupDuplicateCovers() {
  if (!canManageSettings.value || cleanupCoversBusy.value) return;
  cleanupCoversBusy.value = true;
  cleanupCoversToast.value = "";
  try {
    const text = await edgesonicPost("maintenance/cleanupDuplicateCovers", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    cleanupCoversToast.value = t("settings.common.maintenance.cleanupCoversDoneToast", {
      groups: data.groups || 0,
      cleared: data.cleared || 0,
    });
  } catch (e: unknown) {
    cleanupCoversToast.value = t("settings.common.maintenance.cleanupCoversFailed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  cleanupCoversBusy.value = false;
}

const reclaimBusy = ref(false);
const reclaimToast = ref("");
async function onReclaimStaleWork() {
  if (!canManageSettings.value || reclaimBusy.value) return;
  reclaimBusy.value = true;
  reclaimToast.value = "";
  try {
    const text = await edgesonicPost("maintenance/reclaimStaleWork", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    reclaimToast.value = t("settings.common.maintenance.reclaimDoneToast", {
      reclaimed: data.reclaimed || 0,
      requeued: data.requeued || 0,
      failed: data.failed || 0,
    });
  } catch (e: unknown) {
    reclaimToast.value = t("settings.common.maintenance.reclaimFailed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  reclaimBusy.value = false;
}

const resetFailedBusy = ref(false);
const resetFailedToast = ref("");
async function onResetFailedWork() {
  if (!canManageSettings.value || resetFailedBusy.value) return;
  if (!confirm(t("settings.common.maintenance.resetFailedConfirm"))) return;
  resetFailedBusy.value = true;
  resetFailedToast.value = "";
  try {
    const text = await edgesonicPost("maintenance/resetFailedWork", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    resetFailedToast.value = t("settings.common.maintenance.resetFailedDoneToast", {
      reset: data.reset || 0,
    });
  } catch (e: unknown) {
    resetFailedToast.value = t("settings.common.maintenance.resetFailedFailed", {
      error: e instanceof Error ? e.message : String(e),
    });
   }
   resetFailedBusy.value = false;
}

// ---- Activation admin controls (super-admin, features area) ----
// enable_activation gets a dedicated toggle next to the gate-mode picker, so
// it is filtered out of the generic flag list below.
const activationFeature = computed(() => features.value.find((f) => f.key === "enable_activation") ?? null);
const genericFeatures = computed(() => features.value.filter((f) => f.key !== "enable_activation"));

// Flags carry a raw key and a database-authored description. Prefer a
// translated name/description when we ship one, else show what the backend
// gave us so a newly added flag is never invisible.
function featureName(key: string): string {
  const path = `settings.featureKeys.${key}.name`;
  const translated = t(path);
  return translated === path ? key : translated;
}
function featureDesc(f: { key: string; description: string }): string {
  const path = `settings.featureKeys.${f.key}.desc`;
  const translated = t(path);
  return translated === path ? f.description : translated;
}
const gateMode = ref<"all" | "any">("all");
const gateModeBusy = ref(false);

async function saveGateMode(next: "all" | "any") {
  if (gateModeBusy.value || next === gateMode.value) return;
  const prev = gateMode.value;
  gateMode.value = next; // optimistic
  gateModeBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "registration_gate_mode", value: next,
    }));
    if (!data.ok) throw new Error(data.error || "rejected");
    showToast(`registration_gate_mode → ${next}`);
  } catch {
    gateMode.value = prev;
    showToast(t("settings.common.updateFailed", { key: "registration_gate_mode" }), "error");
  }
  gateModeBusy.value = false;
}

async function toggleFeature(f: Feature, checked: boolean) {
  const newValue = checked ? 1 : 0;
  const oldValue = f.value;
  f.value = newValue; // optimistic
  try {
    const text = await edgesonicPost("features/update", { key: f.key, value: newValue });
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "Update rejected");
    showToast(`${f.key} → ${newValue ? t("common.on") : t("common.off")}`);
  } catch {
    f.value = oldValue;
    showToast(t("settings.common.updateFailed", { key: f.key }), "error");
  }
}

async function copyInstanceId() {
  if (!instanceId.value) return;
  try {
    await navigator.clipboard.writeText(instanceId.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { showToast(t("settings.common.copyFailed"), "error"); }
}

interface Session { id: string; userAgent: string; createdAt: number; expiresAt: number; }
const sessions = ref<Session[]>([]);
const sessionsLoading = ref(true);
const sessionsError = ref("");

function formatTs(epochSec: number): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString(locale.value);
}

async function loadSessions(): Promise<boolean> {
  sessionsLoading.value = true;
  sessionsError.value = "";
  try {
    const xml = await edgesonicFetch("auth/sessions/list");
    // 当前 session 被撤销后，签名校验失败 → status="failed" code="40"
    if (/status="failed"/.test(xml) && /code="40"/.test(xml)) {
      sessionsLoading.value = false;
      return false;
    }
    sessions.value = parseXmlAttrs(xml, "session").map((s) => ({
      id: s.id || "",
      userAgent: s.userAgent || "—",
      createdAt: parseInt(s.createdAt || "0"),
      expiresAt: parseInt(s.expiresAt || "0"),
    }));
  } catch {
    sessions.value = [];
    sessionsError.value = t("settings.sessions.loadFailed");
  }
  sessionsLoading.value = false;
  return true;
}

async function revokeSession(id: string) {
  if (!confirm(t("settings.sessions.confirmRevoke"))) return;
  try {
    const xml = await edgesonicPost("auth/sessions/revoke", { id });
    if (/status="failed"/.test(xml)) throw new Error("revoke failed");
    showToast(t("settings.sessions.revoked"));
    // 若撤销的是当前 session，后续签名请求会 401 → 登出回 /login
    const stillValid = await loadSessions();
    if (!stillValid) {
      logout();
      router.push("/login");
    }
  } catch { showToast(t("settings.sessions.revokeFailed"), "error"); }
}

interface Credential { id: string; label: string; lastUsed: number; createdAt: number; streamProxyStrategy: string; }
const credentials = ref<Credential[]>([]);
const credLoading = ref(true);
const credError = ref("");
const credLabel = ref("");
const credBusy = ref(false);
const issued = ref<{ password: string; label: string } | null>(null);
const serverUrl = window.location.origin;

async function loadCredentials() {
  credLoading.value = true;
  credError.value = "";
  try {
    const xml = await edgesonicFetch("auth/credentials/list");
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    credentials.value = parseXmlAttrs(xml, "credential").map((r) => ({
      id: r.id || "",
      label: r.label || "",
      lastUsed: parseInt(r.lastUsed || "0"),
      createdAt: parseInt(r.createdAt || "0"),
      streamProxyStrategy: r.streamProxyStrategy || "always",
    }));
  } catch {
    credentials.value = [];
    credError.value = t("settings.clients.loadFailed");
  }
  credLoading.value = false;
}

function genPassword(): string {
  // unambiguous alphanumerics; 20 chars ≈ 119 bits of entropy
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint32Array(20);
  crypto.getRandomValues(buf);
  return Array.from(buf, (v) => chars[v % chars.length]).join("");
}

async function createCredential() {
  credBusy.value = true;
  const password = genPassword();
  const label = credLabel.value.trim();
  try {
    const xml = await edgesonicPost("auth/credentials/create", { password, label });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    issued.value = { password, label };
    credLabel.value = "";
    await loadCredentials();
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
  }
  credBusy.value = false;
}

async function updateCredentialLabel(cr: { id: string; label: string }, newLabel: string) {
  const trimmed = newLabel.trim();
  if (trimmed === cr.label) return;            // no-op — user pressed blur with no change
  if (trimmed.length > 200) {
    showToast(t("settings.clients.labelTooLong"), "error");
    // Reload to snap the oversized input back to the persisted value — the
    // server would have rejected this anyway (400 Label too long), so we
    // skip the round-trip and just resync from D1.
    await loadCredentials();
    return;
  }
  try {
    const xml = await edgesonicPost("auth/credentials/update", { id: cr.id, label: trimmed });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    cr.label = trimmed;
    showToast(t("settings.clients.labelSaved"));
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
    await loadCredentials();                   // resync UI to server truth
  }
}

async function deleteCredential(id: string) {
  if (!confirm(t("settings.sessions.confirmRevoke"))) return;
  try {
    const xml = await edgesonicPost("auth/credentials/delete", { id });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    if (issued.value) issued.value = null;
    await loadCredentials();
  } catch { showToast(t("settings.clients.loadFailed"), "error"); }
}

const STRATEGY_OPTIONS: Array<{ value: string; key: string }> = [
  { value: "always", key: "settings.clients.strategyAlways" },
  { value: "never", key: "settings.clients.strategyNever" },
  { value: "r2_only", key: "settings.clients.strategyR2Only" },
  { value: "webdav_only", key: "settings.clients.strategyWebdavOnly" },
];
async function updateCredentialStrategy(cr: { id: string; label: string; streamProxyStrategy: string }, newStrategy: string) {
  if (newStrategy === cr.streamProxyStrategy) return;
  try {
    const xml = await edgesonicPost("auth/credentials/update", { id: cr.id, label: cr.label, streamProxyStrategy: newStrategy });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    cr.streamProxyStrategy = newStrategy;
    showToast(t("settings.clients.strategySaved"));
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
    await loadCredentials();
  }
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); showToast(t("common.copied")); }
  catch { showToast(t("settings.common.copyFailed"), "error"); }
}

onMounted(() => {
  if (canManageSettings.value) loadFeatures();
  loadSessions();
  if (!isGuest.value) loadCredentials();
  if (canManageSettings.value) loadWorkerStatus();
  if (hasPerm("manage_cloudflare")) {
    loadCfStatus();
    loadCfCron();
    loadCfAnalytics();
    loadCfUpdates();
  }
});
</script>

<template>
  <div class="settings">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("settings.label") }}</div>
        <h1 class="page-title">{{ t("settings.title") }}</h1>
      </div>
    </div>

    <!-- ============ USER ============ -->
    <section class="settings-section card" :class="{ open: open.user }">
      <button class="section-header" @click="toggleSection('user')">
        <span class="section-title">{{ t("settings.user.title") }}</span>
        <span class="section-caret">{{ open.user ? "−" : "+" }}</span>
      </button>

      <div v-show="open.user" class="section-body">
        <!-- Self-service account (avatar / nickname / password), non-guest -->
        <div v-if="!isGuest" class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.account.title") }}</span></div>
          <div class="account-grid">
            <div class="account-avatar">
              <img
                :src="avatarPreview || selfAvatarSrc"
                class="account-avatar-img"
                alt=""
                @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
              />
              <div class="account-avatar-actions">
                <label class="btn-secondary btn-sm">
                  {{ t("settings.account.avatarPick") }}
                  <input type="file" accept="image/*" hidden @change="onSelfAvatarChange" />
                </label>
                <button v-if="avatarBase64" class="btn-primary btn-sm" :disabled="profileBusy" @click="saveSelfAvatar">
                  {{ t("common.save") }}
                </button>
              </div>
            </div>
            <div class="account-fields">
              <label class="tc-row">
                <span class="tc-key">{{ t("settings.account.nickname") }}</span>
                <input v-model="nicknameInput" type="text" maxlength="64" class="form-input" :placeholder="username" />
              </label>
              <div class="tc-actions">
                <button class="btn-primary btn-sm" :disabled="profileBusy" @click="saveNickname">
                  {{ t("settings.account.saveNickname") }}
                </button>
              </div>

              <label class="tc-row">
                <span class="tc-key">
                  {{ t("settings.account.email") }}
                  <span v-if="email" class="status-badge" :class="emailVerified ? 'success' : 'muted'">
                    {{ emailVerified ? t("settings.account.emailVerified") : t("settings.account.emailUnverified") }}
                  </span>
                </span>
                <input :value="email || t('settings.account.emailNotSet')" type="text" class="form-input" disabled />
              </label>
              <div class="tc-actions">
                <button v-if="!emailChangeOpen" class="btn-secondary btn-sm" :disabled="profileBusy" @click="emailChangeOpen = true">
                  {{ t("settings.account.changeEmail") }}
                </button>
              </div>

              <template v-if="emailChangeOpen">
                <p v-if="emailChangePending" class="feature-desc tc-desc" style="margin-left:0">
                  {{ t("settings.account.emailChangePendingHint") }}
                </p>
                <template v-else>
                  <label class="tc-row">
                    <span class="tc-key">{{ t("settings.account.currentPassword") }}</span>
                    <input v-model="emailChangeCurrentPassword" type="password" maxlength="256" class="form-input" autocomplete="current-password" />
                  </label>
                  <label class="tc-row">
                    <span class="tc-key">{{ t("settings.account.newEmail") }}</span>
                    <input v-model="emailChangeNewEmail" type="email" maxlength="256" class="form-input" autocomplete="email" />
                  </label>
                </template>
                <div class="tc-actions">
                  <button
                    v-if="!emailChangePending"
                    class="btn-primary btn-sm"
                    :disabled="profileBusy || !emailChangeCurrentPassword || !emailChangeNewEmail"
                    @click="submitEmailChangeRequest"
                  >
                    {{ t("settings.account.requestEmailChange") }}
                  </button>
                  <button class="btn-secondary btn-sm" :disabled="profileBusy" @click="cancelEmailChange">
                    {{ t("common.cancel") }}
                  </button>
                </div>
              </template>

              <label class="tc-row">
                <span class="tc-key">{{ t("settings.account.newPassword") }}</span>
                <input v-model="pwNew" type="password" maxlength="128" class="form-input" autocomplete="new-password" />
              </label>
              <label class="tc-row">
                <span class="tc-key">{{ t("settings.account.confirmPassword") }}</span>
                <input v-model="pwConfirm" type="password" maxlength="128" class="form-input" autocomplete="new-password" />
              </label>
              <div class="tc-actions">
                <button class="btn-primary btn-sm" :disabled="profileBusy || !pwNew" @click="saveSelfPassword">
                  {{ t("settings.account.savePassword") }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Language -->
        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.common.language") }}</span></div>
          <div class="lang-row">
            <span class="feature-desc">{{ t("settings.common.languageDesc") }}</span>
            <select class="form-select lang-select" :value="locale" @change="onLocaleChange">
              <option v-for="l in SUPPORTED_LOCALES" :key="l" :value="l">{{ localeLabels[l] }}</option>
            </select>
          </div>
        </div>

        <!-- Theme -->
        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.common.theme") }}</span></div>
          <div class="lang-row">
            <span class="feature-desc">{{ t("settings.common.themeDesc") }}</span>
            <div class="theme-swatches">
              <button
                v-for="th in pickerThemeIds"
                :key="th"
                  type="button"
                  class="theme-swatch"
                  :class="[{ active: activeTheme === th, sp: th.startsWith('sp-') }, `shape-${themeShape(th)}`]"
                  :style="themeSwatchStyle(th)"
                  @click="onThemeChange(th)"
                />
            </div>
          </div>
        </div>

        <!-- External themes -->
        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.common.externalTheme.title") }}</span></div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.externalTheme.desc") }}
          </p>
          <div class="tc-row">
            <input
              v-model="externalThemeUrl"
              type="text"
              maxlength="512"
              class="form-input"
              :placeholder="t('settings.common.externalTheme.placeholder')"
              autocomplete="off"
              @keydown.enter="addExternalTheme"
            />
          </div>
          <div class="tc-actions">
            <button class="btn-primary" :disabled="externalThemeBusy || !externalThemeUrl.trim()" @click="addExternalTheme">
              {{ t("settings.common.externalTheme.load") }}
            </button>
          </div>
          <div v-if="loadedExternalThemeIds.length" class="external-theme-list">
            <div v-for="id in loadedExternalThemeIds" :key="id" class="external-theme-row">
              <span class="external-theme-id">{{ getTheme(id)?.label ?? id }}</span>
              <button class="btn-secondary btn-sm" @click="removeExternalTheme(id)">
                {{ t("settings.common.externalTheme.remove") }}
              </button>
            </div>
          </div>
        </div>

        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.lastfm.title") }}</span>
            <span class="status-badge" :class="(lastfmUsernameSet && lastfmApiKeySet) ? 'success' : (lastfmUsernameSet ? 'warning' : 'muted')">
              {{ (lastfmUsernameSet && lastfmApiKeySet)
                ? t("settings.common.lastfm.fullStatus")
                : (lastfmUsernameSet ? t("settings.common.lastfm.partialStatus") : t("settings.common.lastfm.unsetStatus")) }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.lastfm.userDesc") }}
          </p>

          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.lastfm.usernameLabel") }}</span>
            <input
              v-model="lastfmUsernameInput"
              type="text"
              maxlength="64"
              class="form-input"
              :placeholder="t('settings.common.lastfm.usernamePlaceholder')"
              autocomplete="off"
            />
          </label>
          <div class="tc-actions">
            <button
              v-if="lastfmUsernameSet"
              class="btn-secondary"
              :disabled="lastfmBusy"
              @click="clearLastfmUsername"
              style="margin-right: 0.6rem"
            >
              {{ t("settings.common.lastfm.clear") }}
            </button>
            <button
              class="btn-primary"
              :disabled="lastfmBusy || !lastfmUsernameInput"
              @click="saveLastfmUsername"
            >
              {{ t("settings.common.lastfm.save") }}
            </button>
          </div>

          <div class="sub-header" style="margin-top:0.8rem">
            <span class="mono-label">{{ t("settings.common.lastfm.apiKeyLabel") }}</span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.lastfm.userApiKeyDesc") }}
          </p>
          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.lastfm.apiKeyField") }}</span>
            <input
              v-model="lastfmApiKeyInput"
              type="password"
              maxlength="128"
              class="form-input"
              :placeholder="t('settings.common.lastfm.apiKeyPlaceholder')"
              autocomplete="off"
            />
          </label>
          <div class="tc-actions">
            <button
              v-if="lastfmApiKeySet"
              class="btn-secondary"
              :disabled="lastfmBusy"
              @click="clearLastfmApiKey"
              style="margin-right: 0.6rem"
            >
              {{ t("settings.common.lastfm.clear") }}
            </button>
            <button
              class="btn-primary"
              :disabled="lastfmBusy || !lastfmApiKeyInput"
              @click="saveLastfmApiKey"
            >
              {{ t("settings.common.lastfm.save") }}
            </button>
          </div>
        </div>

      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ ACTIVATION ============ -->
    <section v-if="showActivationSection" class="settings-section card" :class="{ open: open.activation }">
      <button class="section-header" @click="toggleSection('activation')">
        <span class="section-title">{{ t("settings.activation.title") }}</span>
        <span class="section-caret">{{ open.activation ? "−" : "+" }}</span>
      </button>

      <div v-show="open.activation" class="section-body">
        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.activation.current") }}</span></div>
          <div class="act-status-row">
            <span :class="['status-badge', actBadgeClass]">{{ actStatusText }}</span>
            <span v-if="!activation.enabled" class="feature-desc">{{ t("activation.notEnabled") }}</span>
          </div>
        </div>

        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.activation.redeemTitle") }}</span></div>
          <p class="feature-desc section-desc">{{ t("settings.activation.redeemDesc") }}</p>
          <div class="act-redeem-row">
            <input
              v-model="actCode"
              class="form-input act-code-input"
              maxlength="64"
              :placeholder="t('activation.codePlaceholder')"
              autocomplete="off"
              spellcheck="false"
              :disabled="actBusy"
              @keydown.enter.prevent="redeemActivation"
            />
            <button class="btn-primary" :disabled="actBusy || !actCode.trim()" @click="redeemActivation">
              {{ actBusy ? t("activation.redeeming") : t("activation.redeem") }}
            </button>
          </div>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ AUDIO CACHE ============ -->
    <section class="settings-section card" :class="{ open: open.audioCache }">
      <button class="section-header" @click="toggleSection('audioCache')">
        <span class="section-title">{{ t("settings.audioCache.title") }}</span>
        <span class="section-caret">{{ open.audioCache ? "−" : "+" }}</span>
      </button>

      <div v-show="open.audioCache" class="section-body">
        <p class="feature-desc section-desc">{{ t("settings.audioCache.desc") }}</p>

        <div v-if="cacheStats" class="cache-usage">
          <span class="mono-label">
            {{ t("settings.audioCache.usage", { count: cacheStats.count, size: formatSize(cacheStats.bytes), max: formatSize(cacheCapMb * 1024 * 1024) }) }}
          </span>
          <div class="cache-usage-bar"><div class="cache-usage-fill" :style="{ width: cacheUsagePct + '%' }"></div></div>
        </div>
        <p v-else class="feature-desc">{{ t("settings.audioCache.unavailable") }}</p>

        <label class="tc-row">
          <span class="tc-key">{{ t("settings.audioCache.capLabel") }}</span>
          <select v-model.number="cacheCapMb" class="form-input cache-cap-select" @change="onCacheCapChange">
            <option :value="256">256 MB</option>
            <option :value="512">512 MB</option>
            <option :value="1024">1 GB</option>
            <option :value="2048">2 GB</option>
            <option :value="4096">4 GB</option>
            <option :value="8192">8 GB</option>
            <option :value="16384">16 GB</option>
          </select>
        </label>

        <div class="tc-actions">
          <button class="btn-danger" :disabled="cacheBusy || !cacheStats" @click="onClearCache">
            {{ t("settings.audioCache.clear") }}
          </button>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ SYSTEM (advanced — gated on manage_settings) ============ -->
    <section v-if="canManageSettings" class="settings-section card" :class="{ open: open.system }">
      <button class="section-header" @click="toggleSection('system')">
        <span class="section-title">{{ t("settings.system.title") }}</span>
        <span class="section-caret">{{ open.system ? "−" : "+" }}</span>
      </button>

      <div v-show="open.system" class="section-body">
        <!-- Instance ID -->
        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.instance") }}</span>
          </div>
          <div class="instance-row">
            <span class="mono-label">INSTANCE_ID</span>
            <code class="instance-id">{{ instanceId || "—" }}</code>
            <button class="btn-secondary btn-sm" :disabled="!instanceId" @click="copyInstanceId">
              {{ copied ? t("common.copied") : t("common.copy") }}
            </button>
          </div>
        </div>

        <div class="sub-section" :class="{ open: subOpen.media }">
          <button class="sub-section-header" @click="toggleSubSection('media')">
            <span class="sub-section-title">{{ t("settings.system.subMedia") }}</span>
            <span class="sub-section-caret">{{ subOpen.media ? '−' : '+' }}</span>
          </button>
          <div v-show="subOpen.media" class="sub-section-body">

        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.transcode.title") }}</span>
          </div>
          <div class="transcode-grid">
            <!-- Engine -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.transcode.engine") }}</span>
              <select v-model="transcodeEngine" class="form-select" :disabled="!canManageSettings">
                <option value="disabled">{{ t("settings.common.transcode.engineDisabled") }}</option>
                <option value="sandbox">{{ t("settings.common.transcode.engineSandbox") }}</option>
                <option value="external">{{ t("settings.common.transcode.engineExternal") }}</option>
                <option value="browser_pool">{{ t("settings.common.transcode.engineBrowserPool") }}</option>
              </select>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.transcode.engineDesc") }}</p>

            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.transcode.idleTimeout") }}</span>
              <select v-model="sandboxIdleTimeout" class="form-select" :disabled="!canManageSettings">
                <option value="15">{{ t("settings.common.transcode.idle15") }}</option>
                <option value="150">{{ t("settings.common.transcode.idle150") }}</option>
                <option value="300">{{ t("settings.common.transcode.idle300") }}</option>
              </select>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.transcode.idleTimeoutDesc") }}</p>

            <!-- External URL -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.transcode.externalUrl") }}</span>
              <input
                v-model="externalUrl"
                class="form-input"
                :placeholder="t('settings.common.transcode.externalUrlPlaceholder')"
                :disabled="!canManageSettings"
              />
            </label>

            <!-- External key -->
            <label class="tc-row">
              <span class="tc-key">
                {{ t("settings.common.transcode.externalKey") }}
                <span class="status-badge" :class="externalKeySet ? 'success' : 'muted'">
                  {{ externalKeySet ? t("settings.common.transcode.externalKeySet") : t("settings.common.transcode.externalKeyUnset") }}
                </span>
              </span>
              <input
                v-model="externalKeyInput"
                type="password"
                maxlength="256"
                class="form-input"
                :placeholder="t('settings.common.transcode.externalKeyPlaceholder')"
                :disabled="!canManageSettings"
              />
            </label>

            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!canManageSettings || transcodeBusy"
                @click="saveTranscode"
              >
               {{ t("settings.common.transcode.save") }}
              </button>
            </div>
          </div>
        </div>

        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.scrape.title") }}</span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.scrape.desc") }}
          </p>
          <div class="scrape-source-list">
            <div v-for="(id, idx) in scrapeOrder" :key="id" class="scrape-source-row">
              <label class="scrape-source-toggle">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="scrapeEnabledSet.has(id)"
                    :disabled="!canManageSettings"
                    @change="toggleScrapeSource(id, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="toggle-slider"></span>
                </label>
                <span class="scrape-source-label">
                  {{ SCRAPE_ALL_SOURCES.find((s) => s.id === id)?.label || id }}
                </span>
              </label>
              <div class="scrape-source-rank">
                <span class="rank-num">{{ idx + 1 }}</span>
                <button
                  class="rank-btn"
                  :disabled="!canManageSettings || idx === 0"
                  :title="t('settings.common.scrape.moveUp')"
                  @click="moveScrapeSource(id, -1)"
                >▲</button>
                <button
                  class="rank-btn"
                  :disabled="!canManageSettings || idx === scrapeOrder.length - 1"
                  :title="t('settings.common.scrape.moveDown')"
                  @click="moveScrapeSource(id, 1)"
                >▼</button>
              </div>
            </div>
          </div>
          <div class="tc-actions">
            <button
              class="btn-primary"
              :disabled="!canManageSettings || scrapeBusy"
              @click="saveScrape"
            >
             {{ t("settings.common.scrape.save") }}
            </button>
          </div>
        </div>

        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.scan.title") }}</span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.scan.desc") }}
          </p>
          <div class="transcode-grid">
            <!-- Interval -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.scan.intervalHours") }}</span>
              <input
                v-model.number="scanIntervalHours"
                type="number"
                min="0"
                max="168"
                step="1"
                class="form-input"
                :disabled="!canManageSettings"
              />
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.scan.intervalHoursDesc") }}</p>

            <!-- ETag check -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.scan.etagCheck") }}</span>
              <label class="toggle">
                <input
                  type="checkbox"
                  v-model="scanEtagCheck"
                  :disabled="!canManageSettings"
                />
                <span class="toggle-slider"></span>
              </label>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.scan.etagCheckDesc") }}</p>

            <!-- Rescan strategy -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.scan.strategy") }}</span>
              <select v-model="scanRescanStrategy" class="form-select" :disabled="!canManageSettings">
                <option value="auto">{{ t("settings.common.scan.strategyAuto") }}</option>
                <option value="worker">{{ t("settings.common.scan.strategyWorker") }}</option>
                <option value="browser">{{ t("settings.common.scan.strategyBrowser") }}</option>
              </select>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.scan.strategyDesc") }}</p>

            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!canManageSettings || scanBusy"
                @click="saveScan"
              >
               {{ t("settings.common.scan.save") }}
              </button>
            </div>
          </div>
        </div>
          </div>
        </div>

        <div class="sub-section" :class="{ open: subOpen.integrations }">
          <button class="sub-section-header" @click="toggleSubSection('integrations')">
            <span class="sub-section-title">{{ t("settings.system.subIntegrations") }}</span>
            <span class="sub-section-caret">{{ subOpen.integrations ? '−' : '+' }}</span>
          </button>
          <div v-show="subOpen.integrations" class="sub-section-body">

        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.crossOriginIsolation.title") }}</span>
            <span class="status-badge" :class="cioLive ? 'success' : 'muted'">
              {{ cioLive ? t("settings.common.crossOriginIsolation.live") : t("settings.common.crossOriginIsolation.notLive") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.crossOriginIsolation.hint") }}
          </p>
          <div class="transcode-grid">
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.crossOriginIsolation.toggleLabel") }}</span>
              <label class="toggle">
                <input
                  type="checkbox"
                  v-model="cioEnabled"
                  :disabled="!canManageSettings"
                />
                <span class="toggle-slider"></span>
              </label>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.crossOriginIsolation.toggleDesc") }}</p>

            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!canManageSettings || cioBusy"
                @click="saveCio"
              >
               {{ t("settings.common.crossOriginIsolation.save") }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="hasPerm('manage_cloudflare')" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.cf.title") }}</span>
            <span class="status-badge" :class="cfStatus.configured ? 'success' : 'muted'">
              {{ cfStatus.configured ? t("settings.common.cf.configured") : t("settings.common.cf.unconfigured") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.cf.desc") }}
          </p>

          <div class="transcode-grid">
            <!-- Account ID -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.cf.accountId") }}</span>
              <input
                v-model="cfAccountId"
                type="text"
                maxlength="256"
                class="form-input"
                :placeholder="t('settings.common.cf.accountIdPlaceholder')"
                autocomplete="off"
              />
            </label>

            <!-- Token -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.cf.token") }}</span>
              <input
                v-model="cfToken"
                type="password"
                maxlength="256"
                class="form-input"
                :placeholder="cfStatus.configured ? '••••' + cfStatus.tokenLast4 : t('settings.common.cf.tokenPlaceholder')"
                autocomplete="off"
              />
            </label>

            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="!cfStatus.configured || cfTestBusy"
                @click="testCfConn"
                style="margin-right: 0.6rem"
              >
               {{ t("settings.common.cf.test") }}
              </button>
              <button
                class="btn-primary"
                :disabled="cfBusy || !cfToken || !cfAccountId"
                @click="saveCfToken"
              >
               {{ t("settings.common.cf.save") }}
              </button>
            </div>
          </div>

          <hr style="margin: 0.8rem 0; border: none; border-top: 1px dashed var(--color-border-subtle)" />

          <!-- Worker updates -->
          <div class="sub-header" style="margin-top: 0.3rem">
            <span class="mono-label">{{ t("settings.common.cf.updatesTitle") }}</span>
            <button class="btn-secondary btn-sm" :disabled="cfUpdatesBusy" @click="loadCfUpdates">
              {{ t("settings.common.cf.refreshUpdates") }}
            </button>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.cf.updatesDesc") }}
          </p>
          <div v-if="cfUpdates" class="transcode-grid">
            <p class="feature-desc tc-desc">{{ t("settings.common.cf.currentVersion", { ver: cfUpdates.currentVersion }) }}</p>
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.cf.targetVersion") }}</span>
              <select v-model="cfUpdateTag" class="form-input" :disabled="cfUpdateBusy || !cfUpdates.releases.length" @change="cfMajorConfirmed = false">
                <option v-for="release in cfUpdates.releases" :key="release.tag" :value="release.tag">
                  v{{ release.version }}{{ release.prerelease ? ` (${t("settings.common.cf.prerelease")})` : "" }}{{ release.tag === cfUpdates.defaultTag ? ` (${t("settings.common.cf.latest")})` : "" }}
                </option>
              </select>
            </label>
            <p v-if="selectedCfUpdate && !selectedCfUpdate.eligible && (!selectedCfUpdate.isMajor || !selectedCfUpdate.hasArtifact)" class="feature-desc tc-desc">
              {{ t(`settings.common.cf.${cfUpdateReasonKey(selectedCfUpdate.reason)}`) }}
            </p>
            <p v-if="selectedCfUpdate?.isMajor" class="feature-desc tc-desc" style="color: var(--color-accent-primary)">
              {{ t("settings.common.cf.majorWarning") }}
            </p>
            <label v-if="selectedCfUpdate?.isMajor" class="dry-run-row">
              <label class="toggle">
                <input type="checkbox" v-model="cfMajorConfirmed" />
                <span class="toggle-slider"></span>
              </label>
              <span>{{ t("settings.common.cf.confirmMajor") }}</span>
            </label>
            <div class="tc-actions">
              <button class="btn-primary" :disabled="!cfStatus.configured || cfUpdateBusy || !cfUpdateCanRun" @click="runCfUpdate">
                {{ cfUpdateBusy ? t("settings.common.cf.updating") : t("settings.common.cf.updateNow") }}
              </button>
            </div>
          </div>

          <hr style="margin: 0.8rem 0; border: none; border-top: 1px dashed var(--color-border-subtle)" />

          <!-- Cron -->
          <div class="transcode-grid">
            <label class="tc-row tc-row-block">
              <span class="tc-key">{{ t("settings.common.cf.cron") }}</span>
              <textarea
                v-model="cronExpression"
                rows="3"
                class="form-input"
                :placeholder="t('settings.common.cf.cronPlaceholder')"
                style="resize: vertical; font-family: var(--font-mono);"
              ></textarea>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.cf.cronHint") }}</p>

            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="cronBusy"
                @click="loadCfCron"
                style="margin-right: 0.6rem"
              >
               {{ t("settings.common.cf.loadCron") }}
              </button>
              <button
                class="btn-primary"
                :disabled="!cfStatus.configured || cronBusy"
                @click="saveCron"
              >
               {{ t("settings.common.cf.saveCron") }}
              </button>
            </div>

            <p class="feature-desc tc-desc" style="margin-top: 0.6rem; color: var(--color-accent-primary)">
              {{ t("settings.common.cf.ensureCronWarning") }}
            </p>
            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="!cfStatus.configured || cfEnsureCronBusy"
                @click="ensureDefaultCron"
              >
               {{ t("settings.common.cf.ensureCron") }}
              </button>
            </div>
            <p class="feature-desc tc-desc">{{ t("settings.common.cf.ensureCronDesc") }}</p>
          </div>

          <hr style="margin: 0.8rem 0; border: none; border-top: 1px dashed var(--color-border-subtle)" />

          <!-- Analytics -->
          <div class="sub-header" style="margin-top: 0.3rem">
            <span class="mono-label">{{ t("settings.common.cf.analytics") }}</span>
            <button class="btn-secondary btn-sm" :disabled="cfAnalyticsBusy" @click="loadCfAnalytics">
              {{ t("settings.common.cf.refresh") }}
            </button>
          </div>
          <div v-if="cfAnalytics && cfAnalytics.available" class="worker-counts-row">
            <span class="worker-count">{{ t("settings.common.cf.requests") }}: {{ cfAnalytics.requests }}</span>
            <span class="worker-count" :class="(cfAnalytics.errors || 0) > 0 ? 'worker-count-failed' : ''">
              {{ t("settings.common.cf.errors") }}: {{ cfAnalytics.errors }}
            </span>
            <span class="worker-count">{{ t("settings.common.cf.errorRate") }}: {{ ((cfAnalytics.errorRate || 0) * 100).toFixed(2) }}%</span>
            <span class="worker-count">{{ t("settings.common.cf.cpuMs") }}: {{ cfAnalytics.cpuMs }}</span>
            <span class="worker-count">{{ t("settings.common.cf.cpuP99Ms") }}: {{ cfAnalytics.cpuP99Ms }}</span>
          </div>
          <div v-else-if="cfAnalytics && !cfAnalytics.available" class="error-panel">
             <code class="error-text">
               {{ t("settings.common.cf.analyticsUnavailable", { error: cfAnalytics.error || "—" }) }}
             </code>
           </div>
         </div>

        <div v-if="canManageSettings" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.presign.title") }}</span>
            <span class="status-badge" :class="!r2SecretsConfigured ? 'warning' : (r2CredentialValid === false ? 'error' : 'success')">
              {{ !r2SecretsConfigured
                ? t("settings.common.presign.secretsMissing")
                : (r2CredentialValid === false
                  ? t("settings.common.presign.credentialInvalid")
                  : t("settings.common.presign.secretsConfigured")) }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.presign.hint") }}
          </p>

          <!-- R2 secrets missing banner — the most important hint -->
          <div v-if="!r2SecretsConfigured" class="presign-warning">
            <p class="feature-desc" style="margin:0;color:var(--color-accent-warning,#b45309)">
              {{ t("settings.common.presign.r2SecretsMissingHint") }}
            </p>
            <ul class="presign-env-list">
              <li><code>R2_ACCESS_KEY_ID</code></li>
              <li><code>R2_SECRET_ACCESS_KEY</code></li>
              <li><code>CF_ACCOUNT_ID</code> <span style="opacity:0.7">— from Cloudflare integration block above</span></li>
            </ul>
            <p class="feature-desc" style="margin:0.4rem 0 0;color:var(--color-text-muted)">
              {{ t("settings.common.presign.secretPushHint") }}
            </p>
          </div>

          <div v-else-if="r2CredentialValid === false" class="presign-warning">
            <p class="feature-desc" style="margin:0;color:var(--color-status-error)">
              {{ t("settings.common.presign.r2CredentialInvalidHint") }}
            </p>
            <p class="feature-desc" style="margin:0.4rem 0 0;color:var(--color-text-muted)">
              {{ t("settings.common.presign.secretPushHint") }}
            </p>
          </div>

          <div class="transcode-grid">
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.presign.r2Toggle") }}</span>
              <label class="toggle">
                <input type="checkbox" v-model="r2PresignEnabled" :disabled="!canManageSettings" />
                <span class="toggle-slider"></span>
              </label>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.presign.r2ToggleDesc") }}</p>
            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!canManageSettings || r2PresignBusy"
                @click="saveR2Presign"
              >
                {{ t("settings.common.presign.save") }}
              </button>
            </div>

            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.presign.webdavToggle") }}</span>
              <label class="toggle">
                <input type="checkbox" v-model="webdavPresignEnabled" :disabled="!canManageSettings" />
                <span class="toggle-slider"></span>
              </label>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.presign.webdavToggleDesc") }}</p>
            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!canManageSettings || webdavPresignBusy"
                @click="saveWebdavPresign"
              >
               {{ t("settings.common.presign.save") }}
              </button>
             </div>
           </div>
         </div>
           </div>
         </div>

        <div class="sub-section" :class="{ open: subOpen.lastfm }">
          <button class="sub-section-header" @click="toggleSubSection('lastfm')">
            <span class="sub-section-title">{{ t("settings.system.subLastfm") }}</span>
            <span class="sub-section-caret">{{ subOpen.lastfm ? '−' : '+' }}</span>
          </button>
          <div v-show="subOpen.lastfm" class="sub-section-body">

        <div v-if="canManageSettings" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.lastfm.apiKeyLabel") }}</span>
            <span class="status-badge" :class="lastfmSystemKeySet ? 'success' : 'muted'">
              {{ lastfmSystemKeySet ? t("settings.common.lastfm.setStatus") : t("settings.common.lastfm.unsetStatus") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.lastfm.systemDesc") }}
          </p>

          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.lastfm.apiKeyField") }}</span>
            <input
              v-model="lastfmSystemKeyInput"
              type="password"
              maxlength="128"
              class="form-input"
              :placeholder="t('settings.common.lastfm.apiKeyPlaceholder')"
              autocomplete="off"
            />
          </label>
          <div class="tc-actions">
            <button
              v-if="lastfmSystemKeySet"
              class="btn-secondary"
              :disabled="lastfmSystemBusy"
              @click="clearLastfmSystemKey"
              style="margin-right: 0.6rem"
            >
              {{ t("settings.common.lastfm.clear") }}
            </button>
            <button
              class="btn-primary"
              :disabled="lastfmSystemBusy || !lastfmSystemKeyInput"
              @click="saveLastfmSystemKey"
            >
              {{ t("settings.common.lastfm.save") }}
            </button>
          </div>
        </div>

        <div v-if="canManageSettings" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.lastfm.fallbackTitle") }}</span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.lastfm.fallbackDesc") }}
          </p>
          <div class="scrape-source-list">
            <div v-for="(id, idx) in artistInfoOrder" :key="id" class="scrape-source-row">
              <label class="scrape-source-toggle">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="artistInfoEnabledSet.has(id)"
                    :disabled="!canManageSettings"
                    @change="toggleArtistInfoSource(id, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="toggle-slider"></span>
                </label>
                <span class="scrape-source-label">
                  {{ ARTIST_INFO_ALL_SOURCES.find((s) => s.id === id)?.label || id }}
                </span>
              </label>
              <div class="scrape-source-rank">
                <span class="rank-num">{{ idx + 1 }}</span>
                <button
                  class="rank-btn"
                  :disabled="!canManageSettings || idx === 0"
                  :title="t('settings.common.scrape.moveUp')"
                  @click="moveArtistInfoSource(id, -1)"
                >▲</button>
                <button
                  class="rank-btn"
                  :disabled="!canManageSettings || idx === artistInfoOrder.length - 1"
                  :title="t('settings.common.scrape.moveDown')"
                  @click="moveArtistInfoSource(id, 1)"
                >▼</button>
              </div>
            </div>
          </div>
          <div class="tc-actions">
            <button
              class="btn-primary"
              :disabled="!canManageSettings || artistInfoBusy"
              @click="saveArtistInfoSources"
            >
              {{ t("settings.common.lastfm.save") }}
            </button>
          </div>
        </div>

        <div v-if="canManageSettings" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.lastfm.scrapeIntervalTitle") }}</span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.lastfm.scrapeIntervalDesc") }}
          </p>
          <div class="transcode-grid">
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.lastfm.scrapeIntervalField") }}</span>
              <input
                v-model.number="scrapeIntervalHours"
                type="number"
                min="0"
                max="168"
                step="1"
                class="form-input"
                :disabled="!canManageSettings"
              />
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.lastfm.scrapeIntervalHint") }}</p>
            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!canManageSettings || scrapeIntervalBusy"
                @click="saveScrapeInterval"
              >
                {{ t("settings.common.lastfm.save") }}
              </button>
            </div>
          </div>
        </div>

          </div>
        </div>

        <div class="sub-section" :class="{ open: subOpen.email }">
          <button class="sub-section-header" @click="toggleSubSection('email')">
            <span class="sub-section-title">{{ t("settings.system.subEmail") }}</span>
            <span class="sub-section-caret">{{ subOpen.email ? '−' : '+' }}</span>
          </button>
          <div v-show="subOpen.email" class="sub-section-body">

        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.email.resendTitle") }}</span>
            <span class="status-badge" :class="resendKeySet ? 'success' : 'muted'">
              {{ resendKeySet ? t("settings.common.email.configured") : t("settings.common.email.unconfigured") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">{{ t("settings.common.email.resendDesc") }}</p>

          <div class="transcode-grid">
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.apiKey") }}</span>
              <input
                v-model="resendKeyInput"
                type="password"
                maxlength="256"
                class="form-input"
                :placeholder="resendKeySet ? '••••••••' : t('settings.common.email.apiKeyPlaceholder')"
                autocomplete="off"
                :disabled="!canManageSettings"
              />
            </label>
            <div class="tc-actions">
              <button class="btn-secondary" :disabled="!canManageSettings || !resendKeySet || resendBusy" style="margin-right: 0.6rem" @click="clearResendKey">
                {{ t("common.clear") }}
              </button>
              <button class="btn-primary" :disabled="!canManageSettings || !resendKeyInput || resendBusy" @click="saveResendKey">
                {{ t("common.save") }}
              </button>
            </div>

            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.fromEmail") }}</span>
              <input v-model="resendFromEmail" type="email" maxlength="256" class="form-input" placeholder="noreply@example.com" :disabled="!canManageSettings" />
            </label>
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.fromName") }}</span>
              <input v-model="resendFromName" type="text" maxlength="128" class="form-input" :disabled="!canManageSettings" />
            </label>
            <div class="tc-actions">
              <button class="btn-primary" :disabled="!canManageSettings || resendBusy" @click="saveResendFrom">
                {{ t("common.save") }}
              </button>
            </div>

            <hr style="margin: 0.4rem 0; border: none; border-top: 1px dashed var(--color-border-subtle)" />

            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.testTo") }}</span>
              <input v-model="resendTestEmail" type="email" maxlength="256" class="form-input" placeholder="you@example.com" :disabled="!canManageSettings" />
            </label>
            <div class="tc-actions">
              <button class="btn-secondary" :disabled="!canManageSettings || !resendTestEmail || resendTestBusy" @click="sendResendTest">
                {{ resendTestBusy ? t("common.loading") : t("settings.common.email.sendTest") }}
              </button>
            </div>
            <p v-if="resendTestResult" class="feature-desc tc-desc">{{ resendTestResult }}</p>
          </div>
        </div>

        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.common.email.loginPageTitle") }}</span></div>
          <p class="feature-desc tc-desc" style="margin-left:0">{{ t("settings.common.email.loginPageDesc") }}</p>
          <div class="transcode-grid">
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.noticeText") }}</span>
              <input v-model="loginNoticeText" type="text" maxlength="500" class="form-input" :disabled="!canManageSettings" />
            </label>
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.backgroundUrl") }}</span>
              <input v-model="loginBackgroundUrl" type="text" maxlength="2048" class="form-input" placeholder="https://…" :disabled="!canManageSettings" />
            </label>
            <div class="tc-actions">
              <button class="btn-primary" :disabled="!canManageSettings || loginConfigBusy" @click="saveLoginConfig">
                {{ t("common.save") }}
              </button>
            </div>
          </div>
        </div>

        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.email.templatesTitle") }}</span>
            <span v-if="!isSuperAdmin" class="status-badge muted">{{ t("settings.common.email.superAdminOnly") }}</span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">{{ t("settings.common.email.templatesDesc") }}</p>

          <div class="transcode-grid">
            <span class="tc-key" style="grid-column: 1 / -1; font-weight: 600;">{{ t("settings.common.email.tplVerify") }}</span>
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.tplSubject") }}</span>
              <input v-model="emailTplVerifySubject" type="text" maxlength="200" class="form-input" :disabled="!isSuperAdmin" />
            </label>
            <label class="tc-row tc-row-block">
              <span class="tc-key">{{ t("settings.common.email.tplBody") }}</span>
              <textarea v-model="emailTplVerifyBody" rows="6" maxlength="4000" class="form-input" style="resize: vertical; font-family: var(--font-mono);" :disabled="!isSuperAdmin"></textarea>
            </label>
            <div class="tc-actions">
              <button class="btn-primary" :disabled="!isSuperAdmin || emailTplBusy" @click="saveEmailTemplate('verify')">{{ t("common.save") }}</button>
            </div>

            <hr style="grid-column: 1 / -1; margin: 0.4rem 0; border: none; border-top: 1px dashed var(--color-border-subtle)" />

            <span class="tc-key" style="grid-column: 1 / -1; font-weight: 600;">{{ t("settings.common.email.tplReset") }}</span>
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.tplSubject") }}</span>
              <input v-model="emailTplResetSubject" type="text" maxlength="200" class="form-input" :disabled="!isSuperAdmin" />
            </label>
            <label class="tc-row tc-row-block">
              <span class="tc-key">{{ t("settings.common.email.tplBody") }}</span>
              <textarea v-model="emailTplResetBody" rows="6" maxlength="4000" class="form-input" style="resize: vertical; font-family: var(--font-mono);" :disabled="!isSuperAdmin"></textarea>
            </label>
            <div class="tc-actions">
              <button class="btn-primary" :disabled="!isSuperAdmin || emailTplBusy" @click="saveEmailTemplate('reset')">{{ t("common.save") }}</button>
            </div>

            <hr style="grid-column: 1 / -1; margin: 0.4rem 0; border: none; border-top: 1px dashed var(--color-border-subtle)" />

            <span class="tc-key" style="grid-column: 1 / -1; font-weight: 600;">{{ t("settings.common.email.tplChange") }}</span>
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.email.tplSubject") }}</span>
              <input v-model="emailTplChangeSubject" type="text" maxlength="200" class="form-input" :disabled="!isSuperAdmin" />
            </label>
            <label class="tc-row tc-row-block">
              <span class="tc-key">{{ t("settings.common.email.tplBody") }}</span>
              <textarea v-model="emailTplChangeBody" rows="6" maxlength="4000" class="form-input" style="resize: vertical; font-family: var(--font-mono);" :disabled="!isSuperAdmin"></textarea>
            </label>
            <div class="tc-actions">
              <button class="btn-primary" :disabled="!isSuperAdmin || emailTplBusy" @click="saveEmailTemplate('change')">{{ t("common.save") }}</button>
            </div>
          </div>
        </div>

          </div>
        </div>

        <div class="sub-section" :class="{ open: subOpen.workers }">
           <button class="sub-section-header" @click="toggleSubSection('workers')">
            <span class="sub-section-title">{{ t("settings.system.subWorkers") }}</span>
            <span class="sub-section-caret">{{ subOpen.workers ? '−' : '+' }}</span>
          </button>
          <div v-show="subOpen.workers" class="sub-section-body">

        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.workerPool.title") }}</span>
            <span class="status-badge" :class="workPool.eligible ? (workPool.enabled ? 'success' : 'muted') : 'warning'">
              {{ workPool.eligible ? (workPool.enabled ? t("common.on") : t("common.off")) : t("common.off") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.workerPool.desc") }}
          </p>

          <p v-if="!workPool.eligible" class="feature-desc tc-desc" style="margin-left:0; color: var(--color-accent-primary)">
            {{ t("settings.common.workerPool.ineligible") }}
          </p>

          <!-- Admin queue overview -->
          <div v-if="canManageSettings" class="worker-queue-overview">
            <div class="sub-header" style="margin-top: 0.6rem">
              <span class="mono-label">{{ t("settings.common.workerPool.queueOverview") }}</span>
              <button class="btn-secondary btn-sm" :disabled="workerStatusLoading" @click="loadWorkerStatus">
                {{ workerStatusLoading ? t("settings.common.workerPool.refreshing") : t("settings.common.workerPool.refreshStatus") }}
              </button>
            </div>
            <div v-if="workerStatusError" class="error-panel">
              <code class="error-text">{{ workerStatusError }}</code>
            </div>
            <div v-else-if="workerStatus" class="worker-counts-row">
              <span class="worker-count worker-count-queued">{{ t("settings.common.workerPool.queueQueued") }}: {{ workerStatus.counts.queued || 0 }}</span>
              <span class="worker-count worker-count-claimed">{{ t("settings.common.workerPool.queueClaimed") }}: {{ workerStatus.counts.claimed || 0 }}</span>
              <span class="worker-count worker-count-completed">{{ t("settings.common.workerPool.queueCompleted") }}: {{ workerStatus.counts.completed || 0 }}</span>
              <span class="worker-count worker-count-failed">{{ t("settings.common.workerPool.queueFailed") }}: {{ workerStatus.counts.failed || 0 }}</span>
              <span class="worker-count worker-count-canceled">{{ t("settings.common.workerPool.queueCanceled") }}: {{ workerStatus.counts.canceled || 0 }}</span>
            </div>
            <div v-if="workerStatus" class="worker-load-row">
              <span class="mono-label">{{ t("settings.common.workerPool.queueLoad") }}</span>
              <span v-if="workerStatus.load.length === 0" class="feature-desc">{{ t("settings.common.workerPool.noLoad") }}</span>
              <span v-for="l in workerStatus.load" :key="l.username" class="tc-profile-pill">
                {{ t("settings.common.workerPool.loadEntry", { user: l.username, n: l.n }) }}
              </span>
            </div>

            <!-- backfill completed metadata rows that finished before the
                 /work/submit cascade was wired in. Admin-only; idempotent. -->
            <div class="tc-row" style="margin-top: 0.6rem">
              <span class="tc-key">{{ t("settings.common.workerPool.backfillLabel") }}</span>
              <span class="feature-desc">{{ t("settings.common.workerPool.backfillDesc") }}</span>
            </div>
            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="workerBackfillBusy"
                @click="onBackfillCompleted"
              >
               {{ workerBackfillBusy
                  ? t("settings.common.workerPool.backfillRunning")
                  : t("settings.common.workerPool.backfillButton") }}
              </button>
              <span v-if="workerBackfillToast" class="feature-desc" style="margin-left: 0.6rem">{{ workerBackfillToast }}</span>
            </div>

            <!-- cron-driven metadata re-check: interval + manual trigger
                 (unsupported-format retries + lyrics/disc backfill). -->
            <div class="tc-row" style="margin-top: 0.6rem">
              <span class="tc-key">{{ t("settings.common.workerPool.recheckLabel") }}</span>
              <span class="feature-desc">{{ t("settings.common.workerPool.recheckDesc") }}</span>
            </div>
            <div class="tc-actions">
              <input
                v-model.number="metadataRecheckIntervalHours"
                type="number" min="0" max="168" step="1"
                class="free-alloc-input"
                style="width: 5rem"
              />
              <button
                class="btn-sm btn-secondary"
                :disabled="metadataRecheckIntervalBusy"
                @click="saveMetadataRecheckInterval"
              >
               {{ t("settings.common.scan.save") }}
              </button>
              <button
                class="btn-secondary"
                :disabled="recheckMetadataBusy"
                @click="onRecheckMetadataNow"
              >
               {{ recheckMetadataBusy
                  ? t("settings.common.workerPool.recheckRunning")
                  : t("settings.common.workerPool.recheckButton") }}
              </button>
            </div>
            <div v-if="recheckMetadataToast" class="tc-actions">
              <span class="feature-desc">{{ recheckMetadataToast }}</span>
            </div>

            <!-- Cron-driven LRC sidecar backfill: interval + manual
                 trigger. Scans song_masters still missing lyrics for a
                 sibling .lrc file next to the audio source (never retried by
                 the recheck, which only re-parses embedded tags). -->
            <div class="tc-row" style="margin-top: 0.6rem">
              <span class="tc-key">{{ t("settings.common.workerPool.lrcBackfillLabel") }}</span>
              <span class="feature-desc">{{ t("settings.common.workerPool.lrcBackfillDesc") }}</span>
            </div>
            <div class="tc-actions">
              <input
                v-model.number="lrcBackfillIntervalHours"
                type="number" min="0" max="168" step="1"
                class="free-alloc-input"
                style="width: 5rem"
              />
              <button
                class="btn-sm btn-secondary"
                :disabled="lrcBackfillIntervalBusy"
                @click="saveLrcBackfillInterval"
              >
                {{ t("settings.common.scan.save") }}
              </button>
              <button
                class="btn-secondary"
                :disabled="backfillLrcBusy"
                @click="onBackfillLrcNow"
              >
                {{ backfillLrcBusy
                  ? t("settings.common.workerPool.lrcBackfillRunning")
                  : t("settings.common.workerPool.lrcBackfillButton") }}
              </button>
            </div>
            <div v-if="backfillLrcToast" class="tc-actions">
              <span class="feature-desc">{{ backfillLrcToast }}</span>
            </div>
          </div>
        </div>

        <!-- Maintenance tools: idempotent "fix the DB state" knobs tied to
             historical data drift. Each tool here MUST be safe to re-run — no
             destructive cascades. Backend still enforces the granular
             maintenance_* permissions on each action. -->
        <div v-if="canManageSettings" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.maintenance.title") }}</span>
          </div>
          <p class="feature-desc" style="margin: 0 0 0.6rem 0">
            {{ t("settings.common.maintenance.desc") }}
          </p>

          <div class="tc-row">
            <span class="tc-key">{{ t("settings.common.maintenance.cleanupCovers") }}</span>
            <span class="feature-desc">{{ t("settings.common.maintenance.cleanupCoversDesc") }}</span>
          </div>
          <div class="tc-actions">
            <button
              class="btn-secondary"
              :disabled="cleanupCoversBusy"
              @click="onCleanupDuplicateCovers"
            >
             {{ cleanupCoversBusy
                ? t("settings.common.maintenance.cleanupCoversRunning")
                : t("settings.common.maintenance.cleanupCoversButton") }}
            </button>
            <span v-if="cleanupCoversToast" class="feature-desc" style="margin-left: 0.6rem">{{ cleanupCoversToast }}</span>
          </div>

          <!-- manual reclaim of stale work_queue claims. Mirrors the
               052a scheduled sweep so the operator has a "kick" button while
               CF cron schedules are empty (post-deploy / before ensureDefaultCron). -->
          <div class="tc-row">
            <span class="tc-key">{{ t("settings.common.maintenance.reclaimTitle") }}</span>
            <span class="feature-desc">{{ t("settings.common.maintenance.reclaimDesc") }}</span>
          </div>
          <div class="tc-actions">
            <button
              class="btn-secondary"
              :disabled="reclaimBusy"
              @click="onReclaimStaleWork"
            >
             {{ reclaimBusy
                ? t("settings.common.maintenance.reclaimRunning")
                : t("settings.common.maintenance.reclaimButton") }}
            </button>
            <span v-if="reclaimToast" class="feature-desc" style="margin-left: 0.6rem">{{ reclaimToast }}</span>
          </div>
          <p class="feature-desc" style="margin: 0.4rem 0 0 0">
            {{ t("settings.common.maintenance.reclaimHint") }}
          </p>

          <!-- re-queue rows stuck at status='failed'. Browser bundle
               regressions can burn through attempts on every task; once they
               settle at 'failed' the deterministic-id scan can't dispatch
               them again until they're flipped back. -->
          <div class="tc-row">
            <span class="tc-key">{{ t("settings.common.maintenance.resetFailedTitle") }}</span>
            <span class="feature-desc">{{ t("settings.common.maintenance.resetFailedDesc") }}</span>
          </div>
          <div class="tc-actions">
            <button
              class="btn-secondary"
              :disabled="resetFailedBusy"
              @click="onResetFailedWork"
            >
             {{ resetFailedBusy
                ? t("settings.common.maintenance.resetFailedRunning")
                : t("settings.common.maintenance.resetFailedButton") }}
            </button>
            <span v-if="resetFailedToast" class="feature-desc" style="margin-left: 0.6rem">{{ resetFailedToast }}</span>
          </div>
          <p class="feature-desc" style="margin: 0.4rem 0 0 0">
            {{ t("settings.common.maintenance.resetFailedHint") }}
          </p>
        </div>
          </div>
        </div>

        <div class="sub-section" :class="{ open: subOpen.featureFlags }">
          <button class="sub-section-header" @click="toggleSubSection('featureFlags')">
            <span class="sub-section-title">{{ t("settings.system.subFeatureFlags") }}</span>
            <span class="sub-section-caret">{{ subOpen.featureFlags ? '−' : '+' }}</span>
          </button>
          <div v-show="subOpen.featureFlags" class="sub-section-body">

        <!-- Feature flags -->
        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.common.featureFlags") }}</span></div>

          <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>

          <div v-else-if="error" class="error-panel">
            <span class="status-badge error">{{ t("settings.common.apiError") }}</span>
            <p class="error-text">{{ error }}</p>
            <button class="btn-secondary btn-sm" @click="loadFeatures">{{ t("common.retry") }}</button>
          </div>

          <div v-else-if="!features.length" class="empty-state">
            <div class="empty-state-icon"><Icon name="flag" /></div>
            <div>{{ t("settings.common.noFeatures") }}</div>
          </div>

          <div v-else class="feature-list">
            <div v-for="f in genericFeatures" :key="f.key" class="feature-row">
              <div class="feature-info">
                <span class="feature-name">{{ featureName(f.key) }}</span>
                <span class="feature-desc">{{ featureDesc(f) }}</span>
              </div>
              <label class="toggle" :title="canManageSettings ? '' : t('settings.common.levelRequired')">
                <input
                  type="checkbox"
                  :checked="f.value === 1"
                  :disabled="!canManageSettings"
                  @change="toggleFeature(f, ($event.target as HTMLInputElement).checked)"
                />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>

        <!-- Activation system: master switch + registration gate mode -->
        <div v-if="!loading && !error" class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.activation.adminTitle") }}</span></div>
          <div class="feature-list">
            <div class="feature-row">
              <div class="feature-info">
                <span class="feature-name">{{ t("settings.activation.enableTitle") }}</span>
                <span class="feature-desc">{{ t("settings.activation.enableDesc") }}</span>
              </div>
              <label class="toggle" :title="activationFeature ? '' : t('settings.activation.unavailable')">
                <input
                  type="checkbox"
                  :checked="activationFeature?.value === 1"
                  :disabled="!canManageSettings || !activationFeature"
                  @change="activationFeature && toggleFeature(activationFeature, ($event.target as HTMLInputElement).checked)"
                />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="feature-row">
              <div class="feature-info">
                <span class="feature-name">{{ t("settings.activation.gateModeTitle") }}</span>
                <span class="feature-desc">{{ t("settings.activation.gateModeDesc") }}</span>
              </div>
              <div class="seg">
                <button
                  type="button"
                  :class="['seg-btn', { active: gateMode === 'all' }]"
                  :disabled="!canManageSettings || gateModeBusy"
                  @click="saveGateMode('all')"
                >{{ t("settings.activation.gateModeAll") }}</button>
                <button
                  type="button"
                  :class="['seg-btn', { active: gateMode === 'any' }]"
                  :disabled="!canManageSettings || gateModeBusy"
                  @click="saveGateMode('any')"
                >{{ t("settings.activation.gateModeAny") }}</button>
              </div>
            </div>
          </div>
        </div>
          </div>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ SESSIONS ============ -->
    <section class="settings-section card" :class="{ open: open.sessions }">
      <button class="section-header" @click="toggleSection('sessions')">
        <span class="section-title">{{ t("settings.sessions.title") }}</span>
        <span class="section-caret">{{ open.sessions ? "−" : "+" }}</span>
      </button>

      <div v-show="open.sessions" class="section-body">
        <p class="feature-desc section-desc">{{ t("settings.sessions.desc") }}</p>

        <div v-if="sessionsLoading" class="empty-state">{{ t("common.loading") }}</div>

        <div v-else-if="sessionsError" class="error-panel">
          <span class="status-badge error">{{ t("settings.common.apiError") }}</span>
          <p class="error-text">{{ sessionsError }}</p>
          <button class="btn-secondary btn-sm" @click="loadSessions">{{ t("common.retry") }}</button>
        </div>

        <div v-else-if="!sessions.length" class="empty-state">
          <div class="empty-state-icon"><Icon name="empty" /></div>
          <div>{{ t("settings.sessions.empty") }}</div>
        </div>

        <div v-else class="table-wrap session-table" style="--grid-cols: 1fr 1.6fr 1fr 1fr auto">
          <div class="table-header">
            <span>{{ t("settings.sessions.colId") }}</span>
            <span>{{ t("settings.sessions.colUserAgent") }}</span>
            <span>{{ t("settings.sessions.colCreatedAt") }}</span>
            <span>{{ t("settings.sessions.colExpiresAt") }}</span>
            <span></span>
          </div>
          <div v-for="s in sessions" :key="s.id" class="table-row">
            <span class="session-id" :title="s.id">{{ s.id }}</span>
            <span class="session-ua" :title="s.userAgent">{{ s.userAgent }}</span>
            <span class="session-time">{{ formatTs(s.createdAt) }}</span>
            <span class="session-time">{{ formatTs(s.expiresAt) }}</span>
            <span><button class="btn-danger btn-sm" @click="revokeSession(s.id)">{{ t("settings.sessions.revoke") }}</button></span>
          </div>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ SUBSONIC CLIENTS ============ -->
    <section v-if="hasPerm('manage_credentials')" class="settings-section card" :class="{ open: open.clients }">
      <button class="section-header" @click="toggleSection('clients')">
        <span class="section-title">{{ t("settings.clients.title") }}</span>
        <span class="section-caret">{{ open.clients ? "−" : "+" }}</span>
      </button>

      <div v-show="open.clients" class="section-body">
        <p class="feature-desc section-desc">{{ t("settings.clients.desc") }}</p>

        <!-- Issue form -->
        <div class="cred-create">
          <input
            v-model="credLabel"
            class="form-input cred-label-input"
            :placeholder="t('settings.clients.labelPlaceholder')"
            @keydown.enter="createCredential"
          />
          <button class="btn-primary" :disabled="credBusy" @click="createCredential">{{ t("settings.clients.create") }}</button>
        </div>

        <!-- One-time reveal of the issued credential -->
        <div v-if="issued" class="issued-panel">
          <div class="issued-title">{{ t("settings.clients.createdTitle") }}</div>
          <div class="issued-row">
            <span class="mono-label">{{ t("settings.clients.server") }}</span>
            <code class="issued-value">{{ serverUrl }}</code>
            <button class="btn-secondary btn-sm" @click="copyText(serverUrl)">{{ t("common.copy") }}</button>
          </div>
          <div class="issued-row">
            <span class="mono-label">{{ t("settings.clients.username") }}</span>
            <code class="issued-value">{{ username }}</code>
            <button class="btn-secondary btn-sm" @click="copyText(username)">{{ t("common.copy") }}</button>
          </div>
          <div class="issued-row">
            <span class="mono-label">{{ t("settings.clients.password") }}</span>
            <code class="issued-value">{{ issued.password }}</code>
            <button class="btn-secondary btn-sm" @click="copyText(issued.password)">{{ t("common.copy") }}</button>
          </div>
        </div>

        <div v-if="credLoading" class="empty-state">{{ t("common.loading") }}</div>

        <div v-else-if="credError" class="error-panel">
          <span class="status-badge error">{{ t("settings.common.apiError") }}</span>
          <p class="error-text">{{ credError }}</p>
          <button class="btn-secondary btn-sm" @click="loadCredentials">{{ t("common.retry") }}</button>
        </div>

        <div v-else-if="!credentials.length" class="empty-state">
          <div class="empty-state-icon"><Icon name="empty" /></div>
          <div>{{ t("settings.clients.empty") }}</div>
        </div>

        <div v-else class="table-wrap session-table" style="--grid-cols: 1fr 1.4fr 1fr 1fr 1.2fr auto">
          <div class="table-header">
            <span>ID</span>
            <span>{{ t("settings.clients.colLabel") }}</span>
            <span>{{ t("settings.clients.colCreated") }}</span>
            <span>{{ t("settings.clients.colLastUsed") }}</span>
            <span>{{ t("settings.clients.colStrategy") }}</span>
            <span></span>
          </div>
          <div v-for="cr in credentials" :key="cr.id" class="table-row">
            <span class="session-id" :title="cr.id">{{ cr.id }}</span>
            <!-- inline label editor. blur and Enter commit; Esc reverts
                 by reloading the list. We keep the original value in a data-
                 attribute so the handler can detect "no change" cheaply. -->
            <span class="session-ua">
              <input
                class="form-input cred-label-edit"
                :value="cr.label"
                :placeholder="t('settings.clients.labelEditPlaceholder')"
                maxlength="200"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
                @keydown.esc="loadCredentials()"
                @blur="updateCredentialLabel(cr, ($event.target as HTMLInputElement).value)"
              />
            </span>
            <span class="session-time">{{ formatTs(cr.createdAt) }}</span>
            <span class="session-time">{{ cr.lastUsed ? formatTs(cr.lastUsed) : t("settings.clients.never") }}</span>
            <!-- per-credential stream proxy strategy. 302 direct-stream
                 can be toggled per client for backward compatibility. -->
            <span class="session-strategy">
              <select
                class="form-input cred-strategy-select"
                :value="cr.streamProxyStrategy"
                @change="updateCredentialStrategy(cr, ($event.target as HTMLSelectElement).value)"
              >
               <option v-for="opt in STRATEGY_OPTIONS" :key="opt.value" :value="opt.value">{{ t(opt.key) }}</option>
              </select>
            </span>
            <span><button class="btn-danger btn-sm" @click="deleteCredential(cr.id)">{{ t("common.delete") }}</button></span>
          </div>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ PERMISSIONS ============ -->
    <section v-if="isSuperAdmin" class="settings-section card" :class="{ open: open.permissions }">
      <button class="section-header" @click="toggleSection('permissions')">
        <span class="section-title">{{ t("settings.permissions.title") }}</span>
        <span class="section-side">
          <span class="status-badge warning">{{ t("settings.permissions.superOnly") }}</span>
          <span class="section-caret">{{ open.permissions ? "−" : "+" }}</span>
        </span>
      </button>

      <div v-show="open.permissions" class="section-body">
        <PermissionsMatrix />
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
/* --- Accordion sections --- */
.settings-section { padding: 0; margin-bottom: 1.1rem; overflow: hidden; }
.section-header {
  width: 100%;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.95rem 1.2rem;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background 0.15s;
}
.section-header:hover { background: var(--color-bg-tertiary); }
.settings-section.open .section-header { border-bottom: 1px solid var(--color-border-subtle); }
.section-title {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.section-caret {
  font-family: var(--font-mono);
  font-size: 1.1rem;
  color: var(--color-accent-primary);
  width: 20px; text-align: center;
}
.section-side { display: flex; align-items: center; gap: 0.7rem; }
.section-body { padding: 1.1rem 1.2rem 1.3rem; }
.section-desc { margin-bottom: 0.8rem; }

/* --- Sub blocks inside Common --- */
.sub-block { padding: 0.9rem 0; border-bottom: 1px solid var(--color-border-subtle); }
.sub-block:first-child { padding-top: 0; }
.sub-block:last-child { border-bottom: none; padding-bottom: 0; }
.sub-header { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.6rem; }

/* Second-level accordion nested inside SYSTEM's .section-body. Same
   open/toggle shape as .settings-section, one visual step down: smaller
   title, tighter letter-spacing, indented body so the .sub-block rows it
   contains read as "inside a folder" rather than another full section. */
.sub-section { margin: 0 0 0.9rem; border: 1px solid var(--color-border-subtle); border-radius: 2px; overflow: hidden; }
.sub-section:last-child { margin-bottom: 0; }
.sub-section-header {
  width: 100%;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.7rem 0.9rem;
  background: var(--color-bg-secondary);
  border: none;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background 0.15s;
}
.sub-section-header:hover { background: var(--color-bg-tertiary); }
.sub-section.open .sub-section-header { border-bottom: 1px solid var(--color-border-subtle); }
.sub-section-title {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: 0.1em;
}
.sub-section-caret {
  font-family: var(--font-mono);
  font-size: 1rem;
  color: var(--color-accent-primary);
  width: 18px; text-align: center;
}
.sub-section-body { padding: 0.2rem 1rem 0.4rem; background: var(--color-bg-primary); }
.sub-section-body .sub-block { padding-left: 0.2rem; padding-right: 0.2rem; }

.instance-row { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; }
.instance-id {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  color: var(--color-accent-primary);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  padding: 0.3rem 0.7rem;
  letter-spacing: 0.05em;
  user-select: all;
}

.lang-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.lang-select { width: auto; min-width: 160px; }

.theme-swatches { display: grid; grid-template-columns: repeat(7, minmax(70px, 1fr)); gap: 0.45rem; width: min(100%, 620px); }
.theme-swatch {
  position: relative;
  min-height: 38px;
  padding: 0;
  border-radius: 5px;
  border: 1px solid var(--color-border-subtle);
  cursor: pointer;
  /* background-clip padding-box so the 1px border never lets the container
     colour bleed through at the edges. */
  background-clip: padding-box;
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.theme-swatch::after { display: none; }
.theme-swatch.sp::after { content: ""; display: block; position: absolute; width: 17px; height: 17px; right: 7px; bottom: 7px; background: var(--swatch-accent); filter: drop-shadow(0 1px 1px rgba(0,0,0,.35)); }
.theme-swatch.shape-star::after { clip-path: polygon(50% 0, 62% 32%, 100% 50%, 62% 68%, 50% 100%, 38% 68%, 0 50%, 38% 32%); }
.theme-swatch.shape-tetrahedron::after { clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.theme-swatch.shape-icosahedron::after { clip-path: polygon(50% 0, 90% 22%, 100% 62%, 66% 100%, 24% 92%, 0 52%, 14% 17%); }
.theme-swatch.shape-dodecahedron::after { clip-path: polygon(50% 0, 88% 18%, 100% 55%, 72% 100%, 28% 100%, 0 55%, 12% 18%); }
.theme-swatch.shape-octahedron::after { clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
.theme-swatch.shape-cube::after { clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); }
.theme-swatch:hover { transform: translateY(-1px); box-shadow: 0 5px 12px rgba(0,0,0,.18); }
/* Inset ring instead of an outward one: the enclosing .settings-section has
   overflow:hidden, which clipped an outer 0 0 0 2px ring on whichever edge
   the active swatch sat against ("top/bottom/left/right not covered"). An
   inset ring lives entirely inside the button and never clips. */
.theme-swatch.active { border-color: var(--color-accent-primary); box-shadow: inset 0 0 0 2px var(--color-accent-primary), inset 0 0 0 3px rgba(0,0,0,.32); }
@media (max-width: 760px) { .theme-swatches { grid-template-columns: repeat(4, minmax(70px, 1fr)); } }

.external-theme-list { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.6rem; }
.external-theme-row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
  padding: 0.4rem 0.6rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 3px;
}
.external-theme-id {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
}

.feature-list { display: flex; flex-direction: column; }
.feature-row {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.85rem 0.25rem;
  border-bottom: 1px solid var(--color-border-subtle);
}
.feature-row:last-child { border-bottom: none; }
.feature-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.feature-key {
  font-family: var(--font-mono);
  font-size: var(--fs-base);
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--color-text-primary);
}
.feature-name {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--color-text-primary);
}
.feature-desc { font-size: var(--fs-sm); color: var(--color-text-secondary); }

/* --- Sessions table --- */
.session-id, .session-ua {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}
.session-ua { color: var(--color-text-secondary); }
.session-time { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); white-space: nowrap; }

/* --- Subsonic clients --- */
.cred-create { display: flex; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
.cred-label-input { flex: 1; min-width: 220px; }
/* inline label editor inside the credential table row: tight padding so
   it doesn't push the row taller than the read-only siblings. */
.cred-label-edit { width: 100%; padding: 0.25rem 0.4rem; font-size: 0.85rem; }
.issued-panel {
  border: 1px solid var(--color-accent-primary);
  background: var(--color-bg-primary);
  padding: 0.9rem 1rem;
  margin-bottom: 1rem;
  display: flex; flex-direction: column; gap: 0.55rem;
}
.issued-title {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-accent-primary);
}
.issued-row { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; }
.issued-row .mono-label { min-width: 80px; }
.issued-value {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  color: var(--color-text-primary);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
  padding: 0.25rem 0.6rem;
  user-select: all;
}

.error-panel { display: flex; flex-direction: column; align-items: flex-start; gap: 0.7rem; padding: 0.5rem 0; }
.error-text { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-secondary); }

/* --- Transcode controls --- */
.transcode-grid { display: flex; flex-direction: column; gap: 0.65rem; }
.tc-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.tc-row-block { align-items: flex-start; }
.tc-key {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--color-text-primary);
  min-width: 180px;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.tc-row .form-select,
.tc-row .form-input { flex: 1; min-width: 220px; }
.tc-desc { margin-left: 180px; }
.tc-profile-pill {
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
.tc-profile-pill input { margin: 0; }
.tc-actions { margin-top: 0.4rem; display: flex; justify-content: flex-end; }

/* --- Browser audio cache --- */
.cache-usage { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.8rem; }
.cache-usage-bar {
  height: 6px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
  overflow: hidden;
}
.cache-usage-fill {
  height: 100%;
  background: var(--color-accent-primary);
  transition: width 0.3s ease;
}
.cache-cap-select { max-width: 160px; }

/* --- Presign warning banner --- */
.presign-warning {
  margin: 0.6rem 0 0.8rem;
  padding: 0.6rem 0.8rem;
  border-left: 3px solid var(--color-accent-warning, #b45309);
  background: var(--color-surface-2, rgba(255,255,255,0.03));
  border-radius: 4px;
}
.presign-env-list {
  margin: 0.4rem 0 0.4rem 1.2rem;
  padding: 0;
  list-style: disc;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
}
.presign-env-list li { margin: 0.15rem 0; }
.presign-env-list code { background: none; padding: 0; color: inherit; }

/* --- Scan toggle pill --- */
.scan-toggle {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
}
.scan-toggle input { margin: 0; }

/* --- Worker pool --- */
.worker-stats { display: inline-flex; gap: 0.8rem; flex-wrap: wrap; }
.worker-stat {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.04em;
}
.worker-stat-success { color: var(--color-text-primary); }
.worker-stat-error { color: var(--color-accent-primary); }
.worker-queue-overview { margin-top: 0.8rem; border-top: 1px dashed var(--color-border-subtle); padding-top: 0.7rem; }
.worker-counts-row { display: flex; flex-wrap: wrap; gap: 0.6rem; padding: 0.4rem 0; }
.worker-count {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  padding: 0.2rem 0.6rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  letter-spacing: 0.05em;
}
.worker-count-failed, .worker-count-canceled { color: var(--color-accent-primary); }
.worker-load-row {
  display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
  padding-top: 0.4rem;
}

/* --- Scrape source list --- */
.scrape-source-list { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.6rem; }
.scrape-source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.4rem 0.6rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
}
.scrape-source-toggle { display: inline-flex; align-items: center; gap: 0.55rem; cursor: pointer; }
.scrape-source-label {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  color: var(--color-text-primary);
}
.scrape-source-rank { display: inline-flex; align-items: center; gap: 0.4rem; }
.rank-num {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  min-width: 1.5rem;
  text-align: right;
}
.rank-btn {
  width: 24px; height: 24px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border-subtle);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.rank-btn:hover:not(:disabled) { color: var(--color-accent-primary); background: var(--color-bg-primary); }
.rank-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* Self-service account block */
.account-grid { display: flex; gap: 1.2rem; flex-wrap: wrap; align-items: flex-start; }
.account-avatar { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; }
.account-avatar-img {
  width: 96px; height: 96px; border-radius: 50%; object-fit: cover;
  border: 1px solid var(--color-border-subtle); background: var(--color-bg-primary);
}
.account-avatar-actions { display: flex; flex-direction: column; gap: 0.4rem; align-items: stretch; }
.account-fields { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 0.6rem; }

/* Activation section */
.act-status-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.act-redeem-row { display: flex; gap: 0.5rem; max-width: 420px; }
.act-code-input { font-family: var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
</style>
