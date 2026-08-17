import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf-8");

const headersFile = read("web/public/_headers");
const bundleScript = read("scripts/build-update-bundle.mjs");
const workerVersion = read("installer/src/lib/deploy/workerVersion.ts");
const orchestrate = read("installer/src/lib/deploy/orchestrate.ts");
const autoupdate = read("worker/src/utils/autoupdate.ts");
const installerAssets = read("installer/src/lib/deploy/assets.ts");

// Mirrors Cloudflare's asset worker rules engine: a flush-left line opens a
// rule, indented lines below it set headers, and "*" compiles to a splat.
function parseRules(text: string): Array<[string, Record<string, string>]> {
  const rules: Array<[string, Record<string, string>]> = [];
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trimEnd();
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      rules.push([line.trim(), {}]);
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0 || rules.length === 0) continue;
    rules[rules.length - 1][1][line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return rules;
}

function compile(rule: string): RegExp {
  const escaped = rule.split("*").map((part) => part.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"));
  return new RegExp(`^${escaped.join("(?<splat>.*)")}$`);
}

const rules = parseRules(headersFile);

// The engine sets the first match and appends every later one, so two rules
// matching the same path produce a comma-joined, useless Content-Type.
function contentTypeFor(pathname: string): string | undefined {
  const matches = rules
    .filter(([rule]) => compile(rule).test(pathname))
    .map(([, set]) => set["content-type"])
    .filter(Boolean);
  return matches.length === 0 ? undefined : matches.join(", ");
}

const expectations: Array<[string, string]> = [
  ["/", "text/html; charset=utf-8"],
  ["/index.html", "text/html; charset=utf-8"],
  ["/sw.js", "text/javascript; charset=utf-8"],
  ["/assets/index-nVPYXeJr.js", "text/javascript; charset=utf-8"],
  ["/assets/BasicParser-n19nsRSG.js", "text/javascript; charset=utf-8"],
  ["/assets/index-BL80lC3s.css", "text/css; charset=utf-8"],
  ["/favicon.svg", "image/svg+xml"],
  ["/icons/icon-192.png", "image/png"],
  ["/manifest.webmanifest", "application/manifest+json"],
  ["/build-info.json", "application/json"],
];

// A second "*" in one rule makes the engine build a duplicate named group and
// throw the rule away, so the header would silently never apply.
const singleSplatPerRule = rules.every(([rule]) => rule.split("*").length <= 2);

const dist = path.join(root, "web/dist");
function walk(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name), `${prefix}/${entry.name}`) : [`${prefix}/${entry.name}`],
  );
}
const builtPaths = fs.existsSync(dist) ? walk(dist).filter((file) => file !== "/_headers") : [];

const checks: Array<[string, boolean]> = [
  ["every asset path resolves to the expected Content-Type", expectations.every(([pathname, type]) => contentTypeFor(pathname) === type)],
  ["no rule carries more than one splat", singleSplatPerRule],
  ["every built asset is covered by a rule", builtPaths.every((file) => contentTypeFor(file) !== undefined)],
  ["the rules file stays out of the uploaded manifest", bundleScript.includes('ASSET_CONFIG_FILES = new Set(["/_headers", "/_redirects"])')
    && bundleScript.includes("if (ASSET_CONFIG_FILES.has(normalized)) continue;")],
  ["the installer ships the rules in the version metadata", orchestrate.includes('files.has("assets/_headers")')
    && workerVersion.includes("assets.config = { _headers: input.assetHeaders }")],
  ["in-app updates ship the rules in the version metadata", autoupdate.includes('files.has("assets/_headers")')
    && autoupdate.includes("assetMetadata.config = { _headers: assetHeaders }")],
  ["upload MIME tables cover the web manifest", [installerAssets, autoupdate].every((source) => source.includes('case "webmanifest": return "application/manifest+json"'))],
];

let failures = 0;
for (const [label, ok] of checks) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}
if (builtPaths.length === 0) console.log("  … web/dist is absent, skipped the built-asset coverage sweep");
if (failures > 0) {
  console.error(`${failures} assertion(s) failed`);
  process.exit(1);
}
