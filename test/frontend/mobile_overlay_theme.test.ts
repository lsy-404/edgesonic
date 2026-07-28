import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "web/src/App.vue"), "utf-8");
const crystal = fs.readFileSync(path.join(root, "web/src/themes/crystal/background.ts"), "utf-8");
const particles = fs.readFileSync(path.join(root, "web/src/themes/elements/particles.ts"), "utf-8");
const songMenu = fs.readFileSync(path.join(root, "web/src/components/SongRowMenu.vue"), "utf-8");

const collapseLayer = Number(app.match(/\.now-playing-collapse \{[\s\S]*?z-index:\s*(\d+)/)?.[1]);
const overlayLayer = Number(app.match(/\.sidebar-overlay \{[\s\S]*?z-index:\s*(\d+)/)?.[1]);
const sidebarLayer = Number(app.match(/\.sidebar \{[\s\S]*?z-index:\s*(\d+)/)?.[1]);

const checks: [string, boolean][] = [
  ["mobile navigation contains its scroll chain", app.includes("overscroll-behavior-y: contain")],
  ["mobile navigation overlay blocks touch scrolling", app.includes("touch-action: none")],
  ["now-playing collapse stays behind mobile navigation", collapseLayer < overlayLayer && collapseLayer < sidebarLayer],
  ["crystals travel beyond their rendered glow", crystal.includes("const extent = m.size * 1.35 + 2") && crystal.includes("vw + extent * 2")],
  ["theme particles fade at both lifecycle edges", particles.includes("Math.min(1, t / 0.1, (1 - t) / 0.15)")],
  // Every row-menu entry carries an SVG glyph from the Icon set; the download
  // link is an <a>, so it is the one that most easily drifts out of the row.
  ["library download action carries the download glyph", songMenu.includes('<Icon name="download" /> {{ t("library.download") }}</a>')],
  ["row menu items align their glyph with the label", songMenu.includes(".row-menu-item {") && songMenu.includes("gap: 0.5rem;")],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else { failures++; console.error(`  FAIL ${label}`); }
}

if (failures > 0) process.exit(1);
