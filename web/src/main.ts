// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { createApp, watch } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { createPinia } from "pinia";
import { i18n } from "./i18n";
import "./theme"; // side-effect: applies saved theme attribute before first paint
import { setTheme } from "./theme";
import App from "./App.vue";
import Login from "./views/Login.vue";
import Dashboard from "./views/Dashboard.vue";
import Library from "./views/Library.vue";
import Sources from "./views/Sources.vue";
import Files from "./views/Files.vue";
import Users from "./views/Users.vue";
import Settings from "./views/Settings.vue";
import { useUpdateBanner } from "./stores/updateBanner";
import { useDemoMode } from "./stores/demoMode";
import { initNetDiag } from "./lib/netDiag";
import { fetchTextWithTimeout } from "./lib/requestLifecycle";

initNetDiag();
const routes = [
  { path: "/login", component: Login, meta: { title: "Login", public: true } },
  { path: "/register", component: () => import("./views/Register.vue"), meta: { title: "Register", public: true } },
  { path: "/forgot-password", component: () => import("./views/ForgotPassword.vue"), meta: { title: "Forgot Password", public: true } },
  { path: "/reset-password", component: () => import("./views/ResetPassword.vue"), meta: { title: "Reset Password", public: true } },
  { path: "/verify-email", component: () => import("./views/VerifyEmail.vue"), meta: { title: "Verify Email", public: true } },
  { path: "/confirm-email-change", component: () => import("./views/ConfirmEmailChange.vue"), meta: { title: "Confirm Email Change", public: true } },
  // Requires a session but stays reachable for inactive ones — it's where an
  // expired/disabled account redeems an activation code (see the guard below).
  { path: "/activation", component: () => import("./views/ActivationRequired.vue"), meta: { title: "Activation" } },
  { path: "/", component: Dashboard, meta: { title: "Dashboard" } },
  { path: "/library", component: Library, meta: { title: "Library" } },
  { path: "/starred", component: Library, props: { starredOnly: true }, meta: { title: "Liked" } },
  { path: "/sources", component: Sources, meta: { title: "Sources", perm: "manage_sources" } },
  { path: "/files", component: Files, meta: { title: "Files", perm: "manage_files" } },
  { path: "/users", component: Users, meta: { title: "Users", perm: "manage_users" } },
  // Permissions matrix now lives inside Settings; keep the old route working.
  { path: "/permissions", redirect: "/settings" },
  { path: "/settings", component: Settings, meta: { title: "Settings" } },
  // Tools hosts the Subsonic sync (clone-to-self) available to every non-guest;
  // admin-only tools inside gate themselves. Lazy-loaded, rarely visited.
  { path: "/tools", component: () => import("./views/Tools.vue"), meta: { title: "Tools" } },
  // non-admin users so we keep it out of the main chunk.
  { path: "/radio", component: () => import("./views/Radio.vue"), meta: { title: "Radio" } },
  { path: "/podcasts", component: () => import("./views/Podcasts.vue"), meta: { title: "Podcasts" } },
  { path: "/shares", component: () => import("./views/Shares.vue"), meta: { title: "Shares" } },
  // owns its detail state inline so back-nav doesn't re-pick a playlist.
  { path: "/playlists", component: () => import("./views/Playlists.vue"), meta: { title: "Playlists" } },
  { path: "/now-playing", component: () => import("./views/NowPlaying.vue"), meta: { title: "Now Playing" } },
  { path: "/about", component: () => import("./views/About.vue"), meta: { title: "About", minLevel: 0 } },
  // `bare` drops the whole app shell (sidebar, player bar, theme background):
  // a machine parked here is a worker, and every pixel painted is CPU taken
  // from the tasks it is meant to be running.
  { path: "/work", component: () => import("./views/WorkMode.vue"), meta: { title: "Work Mode", perm: "participate_work", bare: true } },
];

const router = createRouter({ history: createWebHashHistory(), routes });

let activeRouteTitle = "";
function syncDocumentTitle(title: unknown) {
  activeRouteTitle = typeof title === "string" ? title : "";
  const pageTitle = activeRouteTitle
    ? i18n.global.t(`pageTitles.${activeRouteTitle}`)
    : "EdgeSonic";
  document.title = pageTitle === "EdgeSonic" ? pageTitle : `${pageTitle} · EdgeSonic`;
}
router.afterEach((to) => syncDocumentTitle(to.meta.title));
watch(() => i18n.global.locale.value, () => syncDocumentTitle(activeRouteTitle));

// 导航守卫：未登录跳 /login
router.beforeEach((to) => {
  // After the httpOnly-cookie upgrade the SPA no longer keeps the session
  // token in localStorage, only a non-secret "logged in" flag — see
  // api.ts's login(). If the cookie has actually expired server-side, the
  // first authenticated fetch will 401/403 and handleAuthError redirects
  // to /login anyway, so this guard is purely to avoid a half-loaded SPA
  // flash on a tab that opened after the cookie expired.
  const loggedIn = !!localStorage.getItem("edgesonic_logged_in");
  if (!to.meta.public && !loggedIn) return "/login";
  if (to.path === "/login" && loggedIn) return "/";

  // Inactive account confinement: when activation is enforced, the session is
  // inactive and guest access is off, everything except /activation (and the
  // public routes handled above) bounces to the redeem page. Both flags come
  // from caches refreshed by fetchMe/App.vue — cold-cache reloads pass
  // through and App.vue redirects once /auth/me lands.
  if (loggedIn && !to.meta.public && to.path !== "/activation") {
    try {
      const act = JSON.parse(localStorage.getItem("edgesonic_activation") || "null");
      if (act && act.enabled === true && act.active === false
        && localStorage.getItem("edgesonic_guest_enabled") !== "1") return "/activation";
    } catch { /* malformed cache — let the page-level gates handle it */ }
  }

  // Permission-gated routes: block direct-URL access to admin pages the user
  // lacks the capability for (nav already hides the tab; this stops typing the
  // path). Uses the cached /auth/me permission map. When the cache is empty
  // (cold reload before fetchMe), allow through — the page's own gate and the
  // backend still enforce, and we don't want to bounce a genuine admin.
  const perm = to.meta.perm as string | string[] | undefined;
  if (perm && loggedIn) {
    let perms: Record<string, boolean> = {};
    try { perms = JSON.parse(localStorage.getItem("edgesonic_perms") || "null") || {}; } catch { perms = {}; }
    if (Object.keys(perms).length > 0) {
      const list = Array.isArray(perm) ? perm : [perm];
      if (!list.some((p) => perms[p] === true)) return "/";
    }
  }
  return true;
});

const app = createApp(App);
app.use(router);
const pinia = createPinia();
app.use(pinia);
app.use(i18n);

// The loaded bundle, not the first delayed API probe, defines the version
// baseline. This preserves newer-release detection across a just-started deploy.
const updateBanner = useUpdateBanner(pinia);
const demoMode = useDemoMode(pinia);
updateBanner.notify({
  version: __EDGESONIC_VERSION__,
});
app.mount("#app");

// deploy. We poll a tiny public endpoint and feed the result into the update
// banner store; it only reacts to a newer stable release than this bundle.
//
// Initial probe runs 5s after mount (give the auth bootstrap room to breathe),
// then every 5 minutes thereafter. Errors are deliberately swallowed — a
// transient blip must NOT trigger a banner.

const VERSION_POLL_INTERVAL_MS = 5 * 60 * 1000;
const VERSION_FIRST_PROBE_DELAY_MS = 5_000;

async function checkVersion() {
  try {
    const { response: r, text } = await fetchTextWithTimeout("/edgesonic/version", { cache: "no-store" });
    if (!r.ok) return;
    const j = JSON.parse(text) as { ok?: boolean; version?: string; demoMode?: boolean; defaultTheme?: string | null; allowAllFileTypes?: boolean };
    if (!j.ok || typeof j.version !== "string") return;
    updateBanner.notify({ version: j.version });
    demoMode.setEnabled(!!j.demoMode);
    demoMode.setAllowAllFileTypes(!!j.allowAllFileTypes);
    // Apply the server-declared default theme on first visit (when the
    // user hasn't picked one yet). Once a theme is in localStorage it
    // wins — this only seeds the initial experience.
    if (typeof j.defaultTheme === "string" && j.defaultTheme && !localStorage.getItem("edgesonic_theme")) {
      setTheme(j.defaultTheme);
    }
  } catch {
    // Network blip / offline tab: ignore. We'll retry next interval.
  }
}

setTimeout(() => {
  void checkVersion();
  setInterval(() => {
    if (document.hidden) return; // tab not visible — skip, retry next tick
    void checkVersion();
  }, VERSION_POLL_INTERVAL_MS);
}, VERSION_FIRST_PROBE_DELAY_MS);

// PWA service worker — only in production (served from same origin with a
// real bundle). Vite dev server would conflict with the SW cache strategy.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .catch((err) => console.warn("[PWA] service worker registration failed:", err));
  });
}
