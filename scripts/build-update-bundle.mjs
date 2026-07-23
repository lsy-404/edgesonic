import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const [stageArg, versionArg, buildTimeArg, allowMajorArg, tagArg] = process.argv.slice(2);
const stage = path.resolve(stageArg || path.join(root, ".update-stage"));
const version = versionArg || process.env.UPDATE_VERSION || "dev";
const buildTime = buildTimeArg || process.env.UPDATE_BUILD_TIME || new Date().toISOString();
const allowMajor = String(allowMajorArg || process.env.UPDATE_ALLOW_MAJOR || "false") === "true";
const tag = tagArg || process.env.UPDATE_TAG || `v${version}`;

async function walk(dir, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assetHash(bytes, rel) {
  const extension = path.extname(rel).slice(1);
  const base64 = Buffer.from(bytes).toString("base64");
  return createHash("sha256").update(base64 + extension).digest("hex").slice(0, 32);
}

function runWrangler(outdir) {
  const args = [
    "wrangler",
    "deploy",
    "--dry-run",
    "--config",
    path.join(root, "worker/update-wrangler.toml"),
    "--outdir",
    outdir,
    "--metafile",
    path.join(outdir, "bundle-meta.json"),
    "--containers-rollout",
    "none",
    "--var",
    `WORKER_VERSION:${version}`,
    "--var",
    `EDGESONIC_VERSION:${version}`,
    "--var",
    `EDGESONIC_BUILD_TIME:${buildTime}`,
  ];
  const result = spawnSync("npx", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`wrangler bundle failed with exit code ${result.status}`);
}

await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });
const bundleDir = path.join(stage, "bundle");
await fs.mkdir(bundleDir, { recursive: true });
runWrangler(bundleDir);

const bundleFiles = await walk(bundleDir);
const workerBundle = bundleFiles.find((file) => file.endsWith(".js") && !file.endsWith(".map"));
if (!workerBundle) throw new Error("Wrangler did not produce a JavaScript Worker bundle");
await fs.copyFile(path.join(bundleDir, workerBundle), path.join(stage, "worker.js"));

const dist = path.join(root, "web/dist");
const assetsDir = path.join(stage, "assets");
await fs.mkdir(path.join(stage, "db"), { recursive: true });
await fs.cp(dist, assetsDir, { recursive: true });
const assetManifest = {};
for (const rel of await walk(dist)) {
  const bytes = await fs.readFile(path.join(dist, rel));
  const normalized = `/${rel.split(path.sep).join("/")}`;
  assetManifest[normalized] = {
    hash: assetHash(bytes, rel),
    size: bytes.length,
  };
}
await fs.writeFile(path.join(stage, "assets-manifest.json"), `${JSON.stringify(assetManifest, null, 2)}\n`);

const patchSource = path.join(root, "worker/updates", `${tag}.sql`);
let dbPatch = null;
try {
  const patch = await fs.readFile(patchSource);
  await fs.mkdir(path.join(stage, "db"), { recursive: true });
  await fs.writeFile(path.join(stage, "db/patch.sql"), patch);
  dbPatch = {
    id: tag,
    path: "db/patch.sql",
    sha256: sha256(patch),
  };
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const archive = path.join(path.dirname(stage), "edgesonic-update.tar.gz");
const tarResult = spawnSync(
  "tar",
  ["czf", archive, "-C", stage, "worker.js", "assets-manifest.json", "assets", "db"],
  { cwd: root, stdio: "inherit" },
);
if (tarResult.status !== 0) throw new Error(`tar failed with exit code ${tarResult.status}`);

const artifact = await fs.readFile(archive);
const manifest = {
  schema: 1,
  tag,
  version,
  buildTime,
  allowMajorUpdate: allowMajor,
  artifact: "edgesonic-update.tar.gz",
  artifactSha256: sha256(artifact),
  artifactBytes: artifact.length,
  workerModule: "worker.js",
  assetsManifest: "assets-manifest.json",
  compatibilityDate: "2025-05-24",
  compatibilityFlags: ["nodejs_compat"],
  dbPatch,
};
await fs.writeFile(
  path.join(path.dirname(stage), "edgesonic-update-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await fs.writeFile(path.join(path.dirname(stage), "edgesonic-update.tar.gz.sha256"), `${manifest.artifactSha256}  edgesonic-update.tar.gz\n`);
console.log(JSON.stringify(manifest, null, 2));
