
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
import MobileNavigation from "./components/MobileNavigation.vue";
import DetailHost from "./components/DetailHost.vue";
import { useDetailStore } from "./stores/detail";
import { WinButton } from "./vendor/winui";
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
const detail = useDetailStore();
const mainRegion = ref<HTMLElement | null>(null);
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

const pageOrder = ["/", "/library", "/starred", "/playlists", "/radio", "/podcasts", "/shares", "/dashboard", "/files", "/sources", "/users", "/tools", "/settings", "/about"];
const pageTransitionName = ref("page-next");
watch(() => route.path, (to, from) => {
  pageTransitionName.value = pageOrder.indexOf(to) < pageOrder.indexOf(from) ? "page-previous" : "page-next";
  detail.close();
});
function resetPageScroll() {
  if (mainRegion.value) mainRegion.value.scrollTop = 0;
}

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

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const levelLabel = computed(() => levelKeys[level.value] ? t(`app.levels.${levelKeys[level.value]}`) : String(level.value));

interface NavItem { label: string; path: string; minLevel: number; perm?: string | string[]; icon: string; }
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
        { label: t("app.menu.home"), path: "/", minLevel: 0, icon: "home" },
        { label: t("app.menu.library"), path: "/library", minLevel: 0, icon: "library" },
        { label: t("app.menu.starred"), path: "/starred", minLevel: 0, icon: "heart" },
        { label: t("app.menu.playlists"), path: "/playlists", minLevel: 0, icon: "playlist" },
        { label: t("app.menu.radio"), path: "/radio", minLevel: 0, icon: "radio" },
        { label: t("app.menu.podcasts"), path: "/podcasts", minLevel: 0, icon: "podcast" },
        { label: t("app.menu.shares"), path: "/shares", minLevel: 0, icon: "share" },
      ],
    },
    {
      label: t("app.groups.management"),
      items: [
        { label: t("app.menu.dashboard"), path: "/dashboard", minLevel: 0, icon: "dashboard" },
        { label: t("app.menu.files"), path: "/files", minLevel: 1, perm: "manage_files", icon: "folder" },
        { label: t("app.menu.sources"), path: "/sources", minLevel: 1, perm: "manage_sources", icon: "library" },
        { label: t("app.menu.users"), path: "/users", minLevel: 1, perm: "manage_users", icon: "users" },
        { label: t("app.menu.tools"), path: "/tools", minLevel: 1, icon: "tools" },
        { label: t("app.menu.settings"), path: "/settings", minLevel: 0, icon: "gear" },
        { label: t("app.menu.about"), path: "/about", minLevel: 0, icon: "help" },
      ],
    },
  ];
  return defs
    .map((g) => ({ ...g, items: g.items.filter((i) => level.value >= i.minLevel && permitted(i.perm)) }))
    .filter((g) => g.items.length > 0);
});

function doLogout() {
  detail.close();
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
      href="https://overture.demo-w10v.workers.dev/?src=lsy-404%2Fedgesonic"
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

  <div
    v-else
    class="shell"
    :class="{
      'details-open': detail.isOpen,
      'demo-shell': demoMode.enabled,
    }"
  >
    <nav class="navbar">
      <div class="nav-left">
        <router-link to="/" class="nav-logo" :aria-label="t('app.menu.home')">
          <img src="/logo.svg" alt="" class="nav-logo-img" />
          <span class="logo-text">EdgeSonic</span>
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

      <div class="nav-user">
        <span class="nav-username">{{ displayName }}</span>
        <span class="status-badge" :class="level >= 3 ? 'warning' : level >= 2 ? 'info' : 'muted'">{{ levelLabel }}</span>
        <MessageCenter :is-super-admin="level >= 3" :can-manage-users="hasPerm('manage_users')" />
        <WinButton class="nav-logout" Style="SubtleButtonStyle" :title="t('app.logout')" :aria-label="t('app.logout')" @Click="doLogout"><Icon name="logout" :size="18" /><span>{{ t("app.logout") }}</span></WinButton>
      </div>

    </nav>

    <aside id="main-sidebar" class="sidebar" :aria-label="t('app.primaryNavigation')">
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
           <Icon :name="item.icon" :size="20" /><span>{{ item.label }}</span>
          </router-link>
        </div>
      </div>

      <div
        class="sidebar-footer-spacer"
        :style="{ height: `${activeThemeDef?.sidebarFooterHeight ?? 0}px` }"
        aria-hidden="true"
      ></div>
    </aside>

    <main ref="mainRegion" class="main" tabindex="-1">
      <router-view v-slot="{ Component, route: activeRoute }">
        <Transition :name="pageTransitionName" mode="out-in" @before-enter="resetPageScroll">
          <div :key="activeRoute.path" class="page-view">
            <component :is="Component" />
          </div>
        </Transition>
      </router-view>
    </main>

    <DetailHost />
    <PlayerBar />
    <MobileNavigation :groups="groups" />
  </div>
</template>

<style>
@import "./assets/palette.css";
@import "./assets/decor.css";
@import "./assets/winui.css";

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
:root {
  --nav-h: 64px;
  --sidebar-w: 224px;
  --mobile-nav-h: 64px;
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --bottom-nav-space: 0px;
}
.shell { height: 100dvh; min-height: 0; overflow: hidden; }
.navbar {
  position: fixed;
  inset: 0 0 auto;
  z-index: 200;
  height: var(--nav-h);
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 24px;
  background: color-mix(in srgb, var(--color-bg-secondary) 92%, transparent);
  backdrop-filter: blur(24px) saturate(140%);
  border-bottom: 1px solid var(--color-border-subtle);
}
.nav-left { display: flex; flex: 0 0 calc(var(--sidebar-w) - 24px); align-items: center; }
.nav-logo { display: inline-flex; align-items: center; gap: 10px; color: var(--color-text-primary); text-decoration: none; white-space: nowrap; font: 600 18px/1.2 var(--font-body); letter-spacing: -0.025em; }
.nav-logo-img { width: 32px; height: 32px; object-fit: contain; }
.nav-global-search { position: relative; display: flex; align-items: center; flex: 0 1 440px; min-width: 0; }
.nav-global-search .form-input { width: 100%; min-width: 0; padding-right: 40px; }
.nav-global-search-submit { position: absolute; right: 4px; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.nav-global-search-submit:hover { background: var(--color-bg-tertiary); color: var(--color-text-primary); }
.nav-global-search-submit svg { width: 17px; height: 17px; }
.nav-user { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-left: auto; min-width: 0; }
.nav-username { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--color-text-secondary); }
.nav-logout { display: flex; gap: 7px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; min-height: 36px; padding: 7px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.icon-button:hover { color: var(--color-text-primary); background: var(--color-bg-tertiary); }
.icon-button:focus-visible, .side-link:focus-visible, .nav-logo:focus-visible { outline: 2px solid var(--color-accent-primary); outline-offset: -2px; }
.sidebar {
  position: fixed;
  top: var(--nav-h);
  bottom: var(--player-h);
  left: 0;
  width: var(--sidebar-w);
  z-index: 150;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--color-bg-secondary) 94%, transparent);
  border-right: 1px solid var(--color-border-subtle);
}
.sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; display: flex; flex-direction: column; gap: 28px; padding: 20px 12px; }
.nav-group { display: flex; flex-direction: column; gap: 4px; }
.nav-group-label { color: var(--color-text-muted); font-size: 12px; font-weight: 600; padding: 0 14px 6px; }
.side-link { position: relative; display: flex; align-items: center; gap: 14px; min-height: 40px; padding: 8px 14px; box-sizing: border-box; border-radius: 4px; color: var(--color-text-secondary); font-size: 14px; text-decoration: none; transition: background 160ms ease, color 160ms ease; }
.side-link:hover { color: var(--color-text-primary); background: var(--color-bg-tertiary); }
.side-link.active { color: var(--color-text-primary); background: var(--color-accent-dim); font-weight: 600; }
.side-link.active::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 2px; background: var(--color-accent-primary); }
.side-link.active .es-icon { color: var(--color-accent-primary); }
.sidebar-footer-spacer { flex-shrink: 0; }
.main {
  position: fixed;
  inset: var(--nav-h) 0 calc(var(--player-h) + var(--bottom-nav-space)) var(--sidebar-w);
  min-width: 0;
  padding: 28px 32px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  outline: none;
  scrollbar-gutter: stable;
}
.page-view { min-width: 0; min-height: 100%; }
.page-next-enter-active, .page-previous-enter-active { transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms ease; }
.page-next-leave-active, .page-previous-leave-active { transition: transform 160ms cubic-bezier(0.4, 0, 1, 1), opacity 140ms ease; }
.page-next-enter-from, .page-previous-leave-to { transform: translateX(48px); opacity: 0; }
.page-next-leave-to, .page-previous-enter-from { transform: translateX(-48px); opacity: 0; }
@media (max-width: 1150px) {
  .nav-user .status-badge { display: none; }
  .nav-username { max-width: 84px; }
}
@media (max-width: 960px) {
  :root { --bottom-nav-space: calc(var(--mobile-nav-h) + var(--safe-bottom)); }
  .navbar { gap: 12px; padding: 0 16px; }
  .nav-left { flex: 0 0 auto; }
  .nav-global-search { flex: 1 1 auto; }
  .nav-user { flex: 0 0 auto; gap: 4px; }
  .nav-username, .nav-logout span { display: none; }
  .sidebar { display: none; }
  .main { left: 0; padding: 20px; }
  .nav-logout { min-width: 36px; padding: 8px; }
}
@media (max-width: 600px) {
  .navbar { gap: 10px; padding: 0 12px; }
  .nav-logo .logo-text { display: none; }
  .nav-logo-img { width: 28px; height: 28px; }
  .main { padding: 20px 16px; scrollbar-gutter: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .page-next-enter-active, .page-next-leave-active, .page-previous-enter-active, .page-previous-leave-active { transition-duration: 1ms; }
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
.demo-shell .main { padding-top: 60px; }
</style>
