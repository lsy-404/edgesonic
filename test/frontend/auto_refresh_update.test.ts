import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/stores/updateBanner.ts"), "utf-8");
const mainSource = fs.readFileSync(path.resolve(__dirname, "../../web/src/main.ts"), "utf-8");
const bannerSource = fs.readFileSync(path.resolve(__dirname, "../../web/src/components/UpdateBanner.vue"), "utf-8");

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log("  ✓ " + name); pass++; }
  else { console.error("  ✗ " + name); fail++; }
}

// Bundle baseline must come from compiled-in constants, not the first poll.
check("bundle baseline uses __EDGESONIC_VERSION__/BUILD_TIME__",
  mainSource.includes("version: __EDGESONIC_VERSION__") &&
  mainSource.includes("buildTime: __EDGESONIC_BUILD_TIME__"));

// Auto-refresh must be gated by an autoRefreshed flag so it cannot loop.
check("notify() only refreshes when autoRefreshed is false",
  source.includes("if (hasUpdate(initial.value, payload) && !autoRefreshed.value)"));
check("autoRefreshed persisted in sessionStorage",
  source.includes("sessionStorage.getItem(AUTO_REFRESH_KEY)") &&
  source.includes("sessionStorage.setItem(AUTO_REFRESH_KEY"));
check("manual refresh() remains unconditional",
  /function refresh\(\)\s*{[^]*window\.location\.reload\(\);[^]*}/.test(source));

// After auto-refresh already happened, banner must still show (stale) so the
// user can decide, instead of looping silently.
check("UpdateBanner renders on showStale",
  bannerSource.includes("banner.available || banner.showStale"));
check("store exposes showStale computed",
  source.includes("showStale = computed("));
check("UpdateBanner surface follows active theme",
  bannerSource.includes("background: color-mix(in srgb, var(--color-bg-elevated)") &&
  bannerSource.includes("box-shadow: 0 6px 32px var(--color-bg-overlay)") &&
  !bannerSource.includes("rgba(20, 20, 22") &&
  !bannerSource.includes("rgba(28, 28, 32"));
check("UpdateBanner controls use theme color tokens",
  bannerSource.includes("border: 1px solid var(--color-border-subtle)") &&
  bannerSource.includes("color: var(--color-text-inverse)"));

if (fail > 0) process.exit(1);
console.log(`  ${pass} passed, ${fail} failed`);
