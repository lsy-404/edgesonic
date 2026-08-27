import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const [stageArg, versionArg, buildTimeArg, allowMajorArg, tagArg, imageRepositoryArg, imageDigestArg] = process.argv.slice(2);
const stage = path.resolve(stageArg || path.join(root, ".update-stage"));
const version = versionArg || process.env.UPDATE_VERSION || "dev";
const buildTime = buildTimeArg || process.env.UPDATE_BUILD_TIME || new Date().toISOString();
const allowMajor = String(allowMajorArg || process.env.UPDATE_ALLOW_MAJOR || "false") === "true";
const tag = tagArg || process.env.UPDATE_TAG || `v${version}`;
const imageRepository = imageRepositoryArg || "";
const imageDigest = imageDigestArg || process.env.EDGESONIC_CONTAINER_IMAGE_DIGEST || "";
if (!/^docker\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(imageRepository)) {
  throw new Error("A Docker Hub image repository (docker.io/<namespace>/<name>) is required");
}
if (!/^sha256:[0-9a-f]{64}$/i.test(imageDigest)) {
  throw new Error("A published container image digest (sha256:<64 hex chars>) is required");
}

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
// Same two files wrangler keeps out of the manifest: they configure asset
// serving instead of being served themselves.
const ASSET_CONFIG_FILES = new Set(["/_headers", "/_redirects"]);

const assetManifest = {};
for (const rel of await walk(dist)) {
  const bytes = await fs.readFile(path.join(dist, rel));
  const normalized = `/${rel.split(path.sep).join("/")}`;
  if (ASSET_CONFIG_FILES.has(normalized)) continue;
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

// The browser deploy wizard reads a package of its own: the data package (the
// same Worker bundle, assets and SQL) plus a small install-configuration asset
// (the recipe, with licence and terms text inlined). The artifact names above
// must stay as they are — deployed instances look up their self-update asset
// by that name.
const recipeSource = path.join(root, "recipe");
const wizardStage = path.join(stage, "overture");
await fs.mkdir(path.join(wizardStage, "worker"), { recursive: true });
await fs.mkdir(path.join(wizardStage, "migrations"), { recursive: true });

// worker/index.js matches recipe.json's worker.module.
await fs.copyFile(path.join(stage, "worker.js"), path.join(wizardStage, "worker/index.js"));
await fs.copyFile(path.join(stage, "assets-manifest.json"), path.join(wizardStage, "assets-manifest.json"));
await fs.cp(assetsDir, path.join(wizardStage, "assets"), { recursive: true });
// Asset content types are repaired server-side from this file; a package that
// lost it would serve assets with an empty type.
await fs.access(path.join(wizardStage, "assets/_headers"));
// The wizard applies the schema from the package instead of fetching it, so the
// SQL always matches the Worker bundle shipped beside it.
await fs.copyFile(path.join(root, "worker/migrations/Schema.sql"), path.join(wizardStage, "migrations/Schema.sql"));
await fs.copyFile(path.join(recipeSource, "recipe.js"), path.join(wizardStage, "recipe.js"));

const wizardArchive = path.join(path.dirname(stage), "overture.tar.gz");
const wizardTar = spawnSync(
  "tar",
  ["czf", wizardArchive, "-C", wizardStage, "recipe.js", "worker", "assets-manifest.json", "assets", "migrations"],
  { cwd: root, stdio: "inherit" },
);
if (wizardTar.status !== 0) throw new Error(`tar failed with exit code ${wizardTar.status}`);

const wizardArtifact = await fs.readFile(wizardArchive);
const wizardArtifactSha256 = sha256(wizardArtifact);

// recipe.json's version/tag/buildTime/package digest have to equal this build's,
// and its licence/terms text is inlined here rather than kept in the package.
const recipe = JSON.parse(await fs.readFile(path.join(recipeSource, "recipe.json"), "utf8"));
const container = recipe.worker?.containers?.find((entry) => entry.className === "Sandbox");
const imagePlaceholder = "docker.io/DOCKERHUB_NAMESPACE/edgesonic-transcoder@sha256:__BUILD_IMAGE_DIGEST__";
if (!container || container.image?.reference !== imagePlaceholder) {
  throw new Error("recipe.json must declare the Sandbox image placeholder");
}
container.image = { reference: `${imageRepository}@${imageDigest.toLowerCase()}` };
recipe.version = version;
recipe.tag = tag;
recipe.buildTime = buildTime;
recipe.package = { artifact: "overture.tar.gz", sha256: wizardArtifactSha256, bytes: wizardArtifact.length };
recipe.license.text = await fs.readFile(path.join(root, "LICENSE"), "utf8");
recipe.terms.texts["zh-CN"] = await fs.readFile(path.join(recipeSource, "terms/zh-CN.md"), "utf8");
recipe.terms.texts["*"] = await fs.readFile(path.join(recipeSource, "terms/en.md"), "utf8");
await fs.writeFile(
  path.join(path.dirname(stage), "overture.json"),
  `${JSON.stringify(recipe, null, 2)}\n`,
);
await fs.writeFile(path.join(path.dirname(stage), "overture.tar.gz.sha256"), `${wizardArtifactSha256}  overture.tar.gz\n`);
console.log(JSON.stringify({ tag, version, buildTime, artifact: "overture.tar.gz", artifactSha256: wizardArtifactSha256 }, null, 2));
