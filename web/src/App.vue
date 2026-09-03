
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, watch, onBeforeUnmount, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth } from "./api";
import PlayerBar from "./components/PlayerBar.vue";
import UpdateBanner from "./components/UpdateBanner.vue";
import MessageCenter from "./components/MessageCenter.vue";
import Icon from "./components/Icon.vue";
import { usePlayerStore } from "./stores/player";
import { useDemoMode } from "./stores/demoMode";
import { activeTheme, resetTheme, restoreSavedTheme } from "./theme";
import { getTheme } from "./themes/registry";
import { ensureBuiltinThemeLoaded } from "./themes/builtin";
import { activeToast, dismissToast } from "./stores/toast";
import { createPlayerKeyboardShortcutHandler } from "./lib/playerKeyboardShortcuts";

const router = useRouter();
const route = useRoute();
// Routes that opt out of the app shell entirely — no sidebar, no player bar,
// no theme background layer. See the /work route in main.ts.
const isBare = computed(() => route.meta?.bare === true);
const { t } = useI18n();
const {
  isLoggedIn, level, logout, hasPerm, fetchMe, displayName, activation, probeGuestEnabled,
  subsonicMasterPasswordNotice, dismissSubsonicMasterPasswordNotice,
} = useAuth();
const player = usePlayerStore();
const demoMode = useDemoMode();

// Inactive-session handling: with guest access on, the account degrades to
// guest caps and we show a persistent "activation expired" banner; with guest
// off, every non-public route is confined to /activation (mirrors the router
// guard, which only sees cached state — this watcher covers fresh /auth/me
// results and the async guest probe).
const guestEnabled = ref<boolean | null>(
  localStorage.getItem("edgesonic_guest_enabled") === "1" ? true
    : localStorage.getItem("edgesonic_guest_enabled") === "0" ? false : null,
);
const activationExpired = computed(() =>
  isLoggedIn.value && activation.value.enabled && !activation.value.active);
const showActivationBanner = computed(() => activationExpired.value && guestEnabled.value === true);
watch(activationExpired, (now) => {
  if (!now) return;
  void probeGuestEnabled().then((enabled) => {
    guestEnabled.value = enabled;
    if (!enabled && !route.meta.public && route.path !== "/activation") {
      void router.replace("/activation");
    }
  });
}, { immediate: true });
function goRenewActivation() {
  void router.push({ path: "/settings", query: { section: "activation" } });
}
function openSubsonicClients() {
  dismissSubsonicMasterPasswordNotice();
  void router.push({ path: "/settings", query: { section: "clients" } });
}
watch(isLoggedIn, (now) => {
  if (now) {
    // Refresh real effective permissions so nav gates by capability, not just
    // level (covers reloads where login()'s fetchMe never ran this session).
    void fetchMe();
    void restoreSavedTheme();
    player.resumePlaybackIfNeeded();
  } else {
    resetTheme();
  }
}, { immediate: true });

const menuOpen = ref(false);
watch(() => route.path, () => { menuOpen.value = false; });

const globalSearchInput = ref<HTMLInputElement | null>(null);
const globalSearchQuery = ref("");

async function focusGlobalSearch() {
  await nextTick();
  globalSearchInput.value?.focus();
  globalSearchInput.value?.select();
}

function submitGlobalSearch() {
  const q = globalSearchQuery.value.trim();
  if (!q) return;
  void router.push({ path: "/library", query: { q } });
}

function clearGlobalSearch() {
  globalSearchQuery.value = "";
  if (route.path === "/library" && typeof route.query.q === "string") {
    const nextQuery = { ...route.query };
    delete nextQuery.q;
    void router.replace({ query: nextQuery });
  }
  globalSearchInput.value?.blur();
}

function onGlobalSearchShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    void focusGlobalSearch();
  }
}

watch(() => route.query.q, (q) => {
  globalSearchQuery.value = typeof q === "string" ? q : "";
}, { immediate: true });
window.addEventListener("keydown", onGlobalSearchShortcut);
const onPlayerKeyboardShortcut = createPlayerKeyboardShortcutHandler({
  hasTrack: () => isLoggedIn.value && !isBare.value && player.hasTrack,
  currentTime: () => player.currentTime,
  duration: () => player.duration,
  volume: () => player.volume,
  toggle: player.toggle,
  previous: player.prev,
  next: player.next,
  seek: player.seek,
  setVolume: player.setVolume,
});
window.addEventListener("keydown", onPlayerKeyboardShortcut);

function openMenuFromLogo() {
  menuOpen.value = true;
}

function collapseNowPlaying() {
  if (window.history.length > 1) router.back();
  else void router.push("/library");
}

const pageTransitionName = ref("page");
router.beforeEach((to, from) => {
  if (to.path === "/now-playing") pageTransitionName.value = "expand";
  else if (from.path === "/now-playing") pageTransitionName.value = "collapse";
  else pageTransitionName.value = "page";
  return true;
});

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const levelLabel = computed(() => levelKeys[level.value] ? t(`app.levels.${levelKeys[level.value]}`) : String(level.value));

// `perm` gates a nav item on real effective capability (from /auth/me), not
// just level: an admin without manage_users sees no Users tab, without
// manage_sources no Sources tab, etc. An array is any-of (Tools serves several
// admin capabilities). `minLevel` is only a coarse floor (guests never
// manage). Settings sits in the bottom group and is visible to every signed-in
// user — its advanced section gates on manage_settings inside.
interface NavItem { label: string; path: string; minLevel: number; perm?: string | string[]; icon?: string; }
interface NavGroup { label: string; items: NavItem[]; }

function permitted(perm?: string | string[]): boolean {
  if (!perm) return true;
  return Array.isArray(perm) ? perm.some(hasPerm) : hasPerm(perm);
}

const groups = computed<NavGroup[]>(() => {
  const defs: NavGroup[] = [
    {
      label: t("app.groups.library"),
      items: [
        { label: t("app.menu.dashboard"), path: "/", minLevel: 0 },
        { label: t("app.menu.library"), path: "/library", minLevel: 0 },
        { label: t("app.menu.starred"), path: "/starred", minLevel: 0 },
        { label: t("app.menu.playlists"), path: "/playlists", minLevel: 0 },
        { label: t("app.menu.radio"), path: "/radio", minLevel: 0 },
        { label: t("app.menu.podcasts"), path: "/podcasts", minLevel: 0 },
        { label: t("app.menu.shares"), path: "/shares", minLevel: 0 },
      ],
    },
    {
      label: t("app.groups.management"),
      items: [
        { label: t("app.menu.files"), path: "/files", minLevel: 1, perm: "manage_files" },
        { label: t("app.menu.sources"), path: "/sources", minLevel: 1, perm: "manage_sources" },
        { label: t("app.menu.users"), path: "/users", minLevel: 1, perm: "manage_users" },
        // Tools hosts the Subsonic sync (clone-to-self), which every non-guest
        // may use; admin-only tools inside gate themselves individually.
        { label: t("app.menu.tools"), path: "/tools", minLevel: 1 },
      ],
    },
    {
      label: t("app.groups.help"),
      items: [
        { label: t("app.menu.settings"), path: "/settings", minLevel: 0 },
        { label: t("app.menu.about"), path: "/about", minLevel: 0 },
      ],
    },
  ];
  return defs
    .map((g) => ({ ...g, items: g.items.filter((i) => level.value >= i.minLevel && permitted(i.perm)) }))
    .filter((g) => g.items.length > 0);
});

function doLogout() {
  player.clear();
  logout();
  router.push("/login");
}

const loadedThemeDef = ref<ReturnType<typeof getTheme>>();
const activeThemeDef = computed(() => getTheme(activeTheme.value) ?? loadedThemeDef.value);
let themeLoadId = 0;
watch(
  activeTheme,
  async (theme) => {
    const loadId = ++themeLoadId;
    await ensureBuiltinThemeLoaded(theme);
    if (loadId === themeLoadId) loadedThemeDef.value = getTheme(theme);
  },
  { immediate: true },
);

const bgHostEl = ref<HTMLElement | null>(null);
let bgCleanup: (() => void) | null = null;
watch(
  [activeThemeDef, bgHostEl],
  ([def, host]) => {
    bgCleanup?.();
    bgCleanup = null;
    if (def?.mountBackground && host) bgCleanup = def.mountBackground(host);
  },
  { immediate: true, flush: "post" },
);
onBeforeUnmount(() => {
  bgCleanup?.();
  bgCleanup = null;
  window.removeEventListener("keydown", onGlobalSearchShortcut);
  window.removeEventListener("keydown", onPlayerKeyboardShortcut);
});
</script>

<template>
  <template v-if="!isBare">
    <component :is="activeThemeDef?.background" v-if="activeThemeDef?.background" />
    <div v-else-if="activeThemeDef?.mountBackground" ref="bgHostEl" aria-hidden="true"></div>
  </template>

  <UpdateBanner />

  <div
    v-if="demoMode.enabled"
    class="demo-badge"
    :class="{ 'demo-badge-authenticated': isLoggedIn }"
    role="status"
    aria-live="polite"
  >
    <span class="demo-badge-text">{{ t("demo.badge") }}</span>
    <a
      class="demo-badge-deploy"
      href="https://overture.demo-w10v.workers.dev/?src=wuyilingwei%2Fedgesonic"
      target="_blank"
      rel="noopener noreferrer"
    >{{ t("demo.easyDeploy") }}</a>
  </div>

  <button
    v-if="showActivationBanner"
    type="button"
    class="activation-banner"
    role="alert"
    @click="goRenewActivation"
  >
    <span aria-hidden="true"><Icon name="info" /></span>
    <span>{{ t("activation.banner") }}</span>
  </button>

  <div
    v-if="subsonicMasterPasswordNotice"
    class="subsonic-password-notice-backdrop"
    @click.self="dismissSubsonicMasterPasswordNotice"
  >
    <section class="card subsonic-password-notice" role="dialog" aria-modal="true" :aria-label="t('subsonicPasswordNotice.title')">
      <h2>{{ t("subsonicPasswordNotice.title") }}</h2>
      <p v-if="subsonicMasterPasswordNotice === 'create_client_password'">
        {{ t("subsonicPasswordNotice.createClientPasswordPrefix") }}
        <button type="button" class="subsonic-password-notice-link" @click="openSubsonicClients">{{ t("subsonicPasswordNotice.clientsLink") }}</button>
      </p>
      <p v-else>{{ t("subsonicPasswordNotice.clientsNotEnabled") }}</p>
      <div class="subsonic-password-notice-actions">
        <button
          v-if="subsonicMasterPasswordNotice === 'create_client_password'"
          type="button"
          class="btn-primary"
          @click="openSubsonicClients"
        >{{ t("subsonicPasswordNotice.openClients") }}</button>
        <button type="button" class="btn-secondary" @click="dismissSubsonicMasterPasswordNotice">{{ t("common.close") }}</button>
      </div>
    </section>
  </div>

  <Transition name="toast">
    <button
      v-if="activeToast"
      type="button"
      :class="['toast', `toast-${activeToast.type}`, 'app-toast']"
      role="alert"
      @click="dismissToast"
    >
      <span aria-hidden="true"><Icon :name="activeToast.type === 'error' ? 'cross' : activeToast.type === 'success' ? 'check' : 'info'" /></span>
      {{ activeToast.message }}
    </button>
  </Transition>

  <!-- 未登录：全屏渲染（Login）；bare 路由同样全屏，不套框架 -->
  <router-view v-if="!isLoggedIn || isBare" />

  <!-- 登录后框架：NavBar + Sidebar + Main + PlayerBar -->
  <div
    v-else
    class="shell"
    :class="{
      'now-playing-shell': route.path === '/now-playing',
      'demo-shell': demoMode.enabled,
    }"
  >
    <nav class="navbar">
      <!-- left: logo; on mobile it toggles the sidebar -->
      <div class="nav-left">
        <button
          class="nav-logo nav-logo-menu"
          aria-controls="main-sidebar"
          :aria-expanded="menuOpen"
          :aria-label="t('app.openNavigation')"
          @click="openMenuFromLogo"
        >
          <img src="/logo.svg" alt="EdgeSonic" class="nav-logo-img" />
          <span class="logo-text">EDGESONIC</span>
        </button>
        <router-link to="/" class="nav-logo nav-logo-home">
          <img src="/logo.svg" alt="EdgeSonic" class="nav-logo-img" />
          <span class="logo-text">EDGESONIC</span>
        </router-link>
      </div>

      <form class="nav-global-search" role="search" @submit.prevent="submitGlobalSearch">
        <label class="sr-only" for="global-library-search">{{ t("app.globalSearch.label") }}</label>
        <input
          id="global-library-search"
          ref="globalSearchInput"
          v-model="globalSearchQuery"
          class="form-input"
          type="search"
          :placeholder="t('app.globalSearch.placeholder')"
          :aria-keyshortcuts="'Meta+K Control+K'"
          @keydown.enter.prevent="submitGlobalSearch"
          @keydown.esc.prevent="clearGlobalSearch"
        />
        <button type="submit" class="nav-global-search-submit" :aria-label="t('app.globalSearch.submit')" :title="t('app.globalSearch.shortcut')">
          <Icon name="search" />
        </button>
      </form>

      <!-- right: user -->
      <div class="nav-user">
        <span class="nav-username">{{ displayName }}</span>
        <span class="status-badge" :class="level >= 3 ? 'warning' : level >= 2 ? 'info' : 'muted'">{{ levelLabel }}</span>
        <MessageCenter :is-super-admin="level >= 3" :can-manage-users="hasPerm('manage_users')" />
        <button class="btn-secondary btn-sm" @click="doLogout">{{ t("app.logout") }}</button>
      </div>

      <div class="nav-scanline"></div>
    </nav>

    <button
      v-if="route.path === '/now-playing'"
      class="now-playing-collapse"
      type="button"
      :title="t('player.collapse')"
      :aria-label="t('player.collapse')"
      @click="collapseNowPlaying"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6z"/></svg>
    </button>

    <div class="sidebar-overlay" :class="{ open: menuOpen }" @click="menuOpen = false"></div>

    <aside id="main-sidebar" class="sidebar" :class="{ open: menuOpen }">
      <div class="sidebar-scroll">
        <div v-for="g in groups" :key="g.label" class="nav-group">
          <div class="nav-group-label">{{ g.label }}</div>
          <router-link
            v-for="item in g.items"
            :key="item.path"
            :to="item.path"
            class="side-link"
            :class="{ active: item.path === '/' ? route.path === '/' : route.path.startsWith(item.path) }"
          >
           <span v-if="item.icon" class="side-emoji" aria-hidden="true">{{ item.icon }}</span>{{ item.label }}
          </router-link>
        </div>
      </div>

      <div
        class="sidebar-footer-spacer"
        :style="{ height: `${activeThemeDef?.sidebarFooterHeight ?? 0}px` }"
        aria-hidden="true"
      ></div>
    </aside>

    <main class="main">
      <router-view v-slot="{ Component, route: activeRoute }">
        <transition :name="pageTransitionName" mode="out-in">
          <component :is="Component" :key="activeRoute.path" />
        </transition>
      </router-view>
    </main>

    <PlayerBar />
  </div>
</template>

<style>
@import "./assets/palette.css";
@import "./assets/decor.css";

/* === App shell === */
.shell,
.login-view {
  position: relative;
  z-index: 1;
}
.shell { min-height: 100vh; }
.app-toast {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  max-width: min(28rem, calc(100vw - 2rem));
  text-align: left;
  cursor: pointer;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.34);
}
.subsonic-password-notice-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgb(0 0 0 / 70%);
}
.subsonic-password-notice { width: min(460px, 100%); padding: 1.25rem; }
.subsonic-password-notice h2 { margin: 0; font-size: 1.1rem; }
.subsonic-password-notice p { margin: 0.8rem 0 1.1rem; color: var(--color-text-secondary); line-height: 1.55; }
.subsonic-password-notice-link {
  display: inline;
  padding: 0;
  border: 0;
  color: var(--color-accent);
  background: transparent;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 0.15em;
  cursor: pointer;
}
.subsonic-password-notice-actions { display: flex; justify-content: flex-end; gap: 0.55rem; }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(0.5rem); }
.shell.now-playing-shell {
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

/* --- NavBar (fixed, 60px) --- */
.navbar {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 200;
  height: var(--nav-h);
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0 1.5rem;
  background: rgba(10, 10, 11, 0.92);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--color-border-subtle);
}
.nav-scanline {
  position: absolute;
  left: 0; right: 0; bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--color-accent-dim), transparent);
  /* Static: the old opacity pulse read as the whole title bar flickering. */
  pointer-events: none;
}
.nav-left {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 1.25rem;
}
.nav-global-search {
  position: relative;
  display: flex;
  align-items: center;
  width: min(28vw, 360px);
}
.nav-global-search .form-input {
  width: 100%;
  min-width: 0;
  padding-right: 2.25rem;
}
.nav-global-search-submit {
  position: absolute;
  right: 0.35rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.7rem;
  height: 1.7rem;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.nav-global-search-submit:hover,
.nav-global-search-submit:focus-visible { color: var(--color-accent-primary); }
.nav-global-search-submit svg { width: 1rem; height: 1rem; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.nav-logo {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--font-mono);
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--color-accent-primary);
  line-height: 1;
  white-space: nowrap;
  text-decoration: none;
}
.nav-logo-menu { display: none; }
.nav-logo-img {
  height: 38px;
  width: 38px;
  object-fit: contain;
  display: block;
}
.nav-links { display: flex; gap: 1.25rem; }
.nav-link {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  transition: color 0.2s;
}
.nav-link:hover, .nav-link.active { color: var(--color-accent-primary); }
.link-prefix { color: var(--color-text-muted); }
.nav-user { display: flex; align-items: center; gap: 0.7rem; flex: 1; justify-content: flex-end; }
.nav-username {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
  letter-spacing: 0.05em;
  max-width: 140px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.now-playing-collapse {
  position: fixed;
  top: calc(var(--nav-h) + 0.75rem);
  left: calc(var(--sidebar-w) + 1.75rem);
  z-index: 130;
  display: none;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-bg-secondary) 78%, transparent);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  transition: color 0.2s, border-color 0.2s, background 0.2s;
}
.now-playing-collapse:hover {
  color: var(--color-accent-primary);
  border-color: var(--color-border-strong);
  background: var(--color-bg-tertiary);
}
/* --- Sidebar (240px) ---
 * .sidebar is the fixed flex host; only .sidebar-scroll (the nav-group
 * list) scrolls. .sidebar-footer-spacer is an empty reserved spacer below
 * it, sized per-theme (see themes/registry.ts's sidebarFooterHeight) — a
 * theme can fade .sidebar's own background to transparent across exactly
 * that height from its own stylesheet, so a shared page-wide background
 * shows through instead of needing a second, separate widget here.
 */
.sidebar {
  position: fixed;
  top: var(--nav-h);
  bottom: var(--player-h);
  left: 0;
  width: var(--sidebar-w);
  z-index: 150;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  transition: transform 0.25s ease, background 0.25s ease;
}
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  padding: 1.25rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-group-label {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.2em;
  color: var(--color-text-muted);
  text-transform: uppercase;
  padding: 0 0.6rem 0.4rem;
}
.side-link {
  display: block;
  padding: 0.45rem 0.6rem;
  font-size: var(--fs-md);
  color: var(--color-text-secondary);
  border-left: 2px solid transparent;
  border-radius: 0 2px 2px 0;
  transition: all 0.15s;
}
.side-link:hover { color: var(--color-text-primary); background: var(--color-bg-tertiary); }
.side-link.active {
  color: var(--color-accent-primary);
  background: var(--color-accent-dim);
  border-left-color: var(--color-accent-primary);
}
/* optional emoji prefix inside .side-link — generic for future nav items. */
.side-emoji {
  display: inline-block;
  margin-right: 0.45rem;
  font-size: 0.95em;
  vertical-align: -1px;
}
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 140;
  background: var(--color-bg-overlay);
  touch-action: none;
}

/* Reserved space at the bottom of the sidebar flex column, sized from the
 * active theme's `sidebarFooterHeight` (0 for themes that don't set one —
 * see themes/registry.ts). A theme that wants this space to visually bleed
 * into a shared page background does so via its own stylesheet targeting
 * `.sidebar` directly (e.g. themes/elements/elements.css); this file never
 * mentions any specific theme.
 */
.sidebar-footer-spacer {
  flex-shrink: 0;
}

/* --- Main content --- */
.main {
  margin-left: var(--sidebar-w);
  padding: calc(var(--nav-h) + 1.5rem) 1.75rem calc(var(--player-h) + 1.5rem);
  min-height: 100vh;
}
.now-playing-shell .main {
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.now-playing-shell .nowplaying {
  height: auto;
  flex: 1;
  min-height: 0;
}

/* --- Page transitions ---
 * "page": plain navigation between regular views.
 * "expand"/"collapse": entering/leaving /now-playing — a bottom-sheet motion
 * that reads as the detail view growing out of (and shrinking back into) the
 * player bar it's opened from.
 */
.page-enter-active, .page-leave-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.page-enter-from { opacity: 0; transform: translateY(8px); }
.page-leave-to { opacity: 0; transform: translateY(-8px); }

.expand-enter-active { transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
.expand-enter-from { opacity: 0; transform: translateY(48px) scale(0.97); }
.expand-leave-active { transition: opacity 0.15s ease; }
.expand-leave-to { opacity: 0; }

.collapse-enter-active { transition: opacity 0.2s ease; }
.collapse-enter-from { opacity: 0; }
.collapse-leave-active { transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.4, 0, 1, 1); }
.collapse-leave-to { opacity: 0; transform: translateY(48px) scale(0.97); }

/* --- Responsive: ≤960px 侧栏由 Logo 展开 --- */
@media (max-width: 960px) {
  .navbar { gap: 0.6rem; padding: 0 0.75rem; }
  .nav-left { flex: 0 0 auto; }
  .nav-global-search { flex: 1 1 auto; width: auto; min-width: 0; }
  .nav-user { flex: 0 0 auto; }
  .nav-user .status-badge { display: none; }
  .nav-logo-home { display: none; }
  .nav-logo-menu { display: flex; }
  .nav-links { display: none; }
  .nav-username { display: none; }
  .sidebar { transform: translateX(-100%); bottom: 0; box-shadow: 8px 0 40px rgba(0, 0, 0, 0.6); }
  .sidebar.open { transform: translateX(0); }
  .sidebar-overlay.open { display: block; }
  .main { margin-left: 0; padding-left: 1rem; padding-right: 1rem; }
  .now-playing-collapse { display: inline-flex; left: 1rem; }
}

@media (max-width: 600px) {
  .nav-logo .logo-text { display: none; }
}

/* --- Activation expired banner (persistent, click → Settings) --- */
.activation-banner {
  position: fixed;
  top: calc(var(--nav-h) + 0.5rem);
  left: 50%;
  transform: translateX(-50%);
  z-index: 1900;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.9rem;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-status-warning);
  box-shadow: inset 3px 0 var(--color-status-warning), 0 8px 18px rgba(0, 0, 0, 0.3);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  max-width: calc(100vw - 2rem);
  overflow: hidden;
  text-overflow: ellipsis;
}
.activation-banner:hover { border-color: var(--color-status-error); }

/* --- Demo mode badge --- */
.demo-badge {
  position: fixed;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  background: rgba(255, 165, 0, 0.85);
  color: #1a1a1a;
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.demo-badge-text { white-space: nowrap; }
.demo-badge-deploy {
  pointer-events: auto;
  white-space: nowrap;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.demo-badge-authenticated { top: calc(var(--nav-h) + 0.45rem); }
.demo-shell .sidebar { top: calc(var(--nav-h) + 2.25rem); }
.demo-shell .main { padding-top: calc(var(--nav-h) + 3.75rem); }
</style>
