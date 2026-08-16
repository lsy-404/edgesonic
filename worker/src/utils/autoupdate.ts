// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assetOf,
  buildReleaseOptions,
  classifyVersionUpdate,
  compareSemver,
  GITHUB_API,
  GITHUB_REPO,
  hasUpdateArtifact,
  normalizeTag,
  parseSemver,
  UPDATE_ARTIFACT_NAME,
  UPDATE_MANIFEST_NAME,
  ZERO_VERSION,
  type GithubAsset,
  type GithubRelease,
  type ReleaseListing,
  type ReleaseOption,
  type Semver,
} from "../../../shared/autoupdate";

// Version maths and release eligibility are shared with the SPA, which lists
// releases straight from the browser; re-exported so existing importers and
// tests keep a single entry point.
export { classifyVersionUpdate, compareSemver, normalizeTag, parseSemver };
export type { ReleaseOption, Semver };

const CF_API = "https://api.cloudflare.com/client/v4";
const LOCK_TTL_SEC = 15 * 60;
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const MAX_WORKER_BYTES = 12 * 1024 * 1024;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;

const ACTIVE_UPDATE_STATUSES = ["resolving", "downloading", "patching", "uploading", "deploying"];

export interface UpdateManifest {
  schema: 1;
  tag: string;
  version: string;
  buildTime: string;
  allowMajorUpdate?: boolean;
  artifact: string;
  artifactSha256: string;
  artifactBytes?: number;
  workerModule: string;
  assetsManifest: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  dbPatch?: {
    id: string;
    path: string;
    sha256: string;
  } | null;
}

export interface UpdateState {
  status: string;
  operation_id: string | null;
  target_tag: string | null;
  target_version: string | null;
  version_id: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
}

interface AssetEntry {
  hash: string;
  size: number;
}

type AssetManifest = Record<string, AssetEntry>;

export class UpdateError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "UpdateError";
  }
}

// GitHub answers a spent rate limit with 403, not 429, so the status alone
// can't be told apart from a genuine permission failure. Pull the reason out
// of the headers/body and put it in the error the operator sees.
async function githubFailureDetail(response: Response): Promise<string> {
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "unknown";
    return `: GitHub API rate limit exhausted (resets ${when}); configure a GITHUB_TOKEN secret to raise it`;
  }
  try {
    const body = await response.json() as { message?: string };
    return body?.message ? `: ${body.message.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

async function githubJson<T>(env: Env, url: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "EdgeSonic-AutoUpdate",
  };
  // Unauthenticated calls are capped at 60/hour per source IP. Workers egress
  // from shared Cloudflare addresses, so that budget is spent by unrelated
  // tenants and lookups fail even on a first attempt. A token lifts the cap to
  // 5000/hour and scopes it to this deployment; public repos need no scopes.
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new UpdateError(`GitHub release lookup failed (HTTP ${response.status})${await githubFailureDetail(response)}`, 502);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new UpdateError("GitHub returned invalid release JSON", 502);
  }
}

async function githubReleases(env: Env): Promise<GithubRelease[]> {
  const releases = await githubJson<GithubRelease[]>(env, `${GITHUB_API}/releases?per_page=50`);
  return releases.filter((r) => !r.draft && typeof r.tag_name === "string");
}

async function githubReleaseByTag(env: Env, tag: string, known?: GithubRelease[]): Promise<GithubRelease> {
  const exact = (known || []).find((r) => r.tag_name === tag);
  if (exact) return exact;
  return githubJson<GithubRelease>(env, `${GITHUB_API}/releases/tags/${encodeURIComponent(tag)}`);
}

async function currentVersion(env: Env, requestUrl: string): Promise<Semver> {
  const direct = env.EDGESONIC_VERSION ? parseSemver(env.EDGESONIC_VERSION) : null;
  if (direct) return direct;
  try {
    const assetResponse = await env.ASSETS.fetch(new Request(new URL("/build-info.json", requestUrl)));
    if (assetResponse.ok) {
      const info = await assetResponse.json() as { version?: string };
      const fromAsset = info.version ? parseSemver(info.version) : null;
      if (fromAsset) return fromAsset;
    }
  } catch {
    // Fall through to the zero version for old or incomplete deployments.
  }
  return ZERO_VERSION;
}

// Kept as the SPA's fallback for when the browser can't reach GitHub itself
// (blocked network, offline). The happy path lists releases client-side.
export async function listUpdates(env: Env, requestUrl: string): Promise<ReleaseListing> {
  const current = await currentVersion(env, requestUrl);
  return buildReleaseOptions(await githubReleases(env), current);
}

async function cfJson<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  let body: { success?: boolean; result?: T; errors?: Array<{ message?: string }> };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new UpdateError(`Cloudflare API returned non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok || !body.success || body.result === undefined) {
    throw new UpdateError(body.errors?.[0]?.message || `Cloudflare API request failed (HTTP ${response.status})`);
  }
  return body.result;
}

async function cfMultipart<T>(token: string, path: string, form: FormData): Promise<T> {
  const response = await fetch(`${CF_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let body: { success?: boolean; result?: T; errors?: Array<{ message?: string }> };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new UpdateError(`Cloudflare upload returned non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok || !body.success || body.result === undefined) {
    throw new UpdateError(body.errors?.[0]?.message || `Cloudflare upload failed (HTTP ${response.status})`);
  }
  return body.result;
}

async function downloadBytes(url: string, maxBytes: number, label: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "EdgeSonic-AutoUpdate",
    },
  });
  if (!response.ok) throw new UpdateError(`${label} download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length") || "0");
  if (length > maxBytes) throw new UpdateError(`${label} is too large`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new UpdateError(`${label} is too large`);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readTarText(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(bytes.slice(start, end)).replace(/\0.*$/, "").trim();
}

function readTarOctal(bytes: Uint8Array, start: number, end: number): number {
  const text = readTarText(bytes, start, end).replace(/[^0-7].*$/, "");
  return text ? parseInt(text, 8) : 0;
}

async function unpackArtifact(archive: Uint8Array): Promise<Map<string, Uint8Array>> {
  let decompressed: Uint8Array;
  try {
    const stream = new Blob([archive.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_UNPACKED_BYTES) throw new UpdateError("Update artifact expands beyond the size limit", 400);
      chunks.push(part.value);
    }
    decompressed = new Uint8Array(total);
    let writeOffset = 0;
    for (const chunk of chunks) {
      decompressed.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError("Update artifact is not a valid gzip archive", 400);
  }
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let entries = 0;
  while (offset + 512 <= decompressed.byteLength) {
    const header = decompressed.subarray(offset, offset + 512);
    let empty = true;
    for (const byte of header) {
      if (byte !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) break;
    const name = readTarText(decompressed, offset, offset + 100);
    const prefix = readTarText(decompressed, offset + 345, offset + 500);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(decompressed, offset + 124, offset + 136);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!fullName || dataEnd > decompressed.byteLength) throw new UpdateError("Update artifact contains an invalid tar entry", 400);
    if (++entries > 1000) throw new UpdateError("Update artifact contains too many files", 400);
    const type = decompressed[offset + 156];
    if (type === 0 || type === 48) files.set(fullName, decompressed.slice(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function textFile(files: Map<string, Uint8Array>, name: string): string {
  const bytes = files.get(name);
  if (!bytes) throw new UpdateError(`Update artifact is missing ${name}`, 400);
  return new TextDecoder().decode(bytes);
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function assetFileName(assetPath: string): string {
  const clean = assetPath.replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.includes("\\")) throw new UpdateError("Invalid asset path in update manifest", 400);
  return `assets/${clean}`;
}

function assetContentType(assetPath: string): string {
  const extension = assetPath.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "js":
    case "mjs": return "text/javascript";
    case "css": return "text/css";
    case "html": return "text/html";
    case "json": return "application/json";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "ico": return "image/x-icon";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

async function uploadAssets(
  token: string,
  accountId: string,
  script: string,
  files: Map<string, Uint8Array>,
  manifest: AssetManifest,
): Promise<string> {
  const hashes = new Map<string, { path: string; entry: AssetEntry }>();
  let totalBytes = 0;
  for (const [assetPath, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry.hash !== "string" || !/^[0-9a-f]{32}$/i.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new UpdateError("Invalid asset manifest", 400);
    }
    const bytes = files.get(assetFileName(assetPath));
    if (!bytes || bytes.byteLength !== entry.size) throw new UpdateError(`Asset is missing or has an invalid size: ${assetPath}`, 400);
    totalBytes += bytes.byteLength;
    hashes.set(entry.hash, { path: assetPath, entry });
  }
  if (totalBytes > MAX_ASSET_BYTES) throw new UpdateError("Static assets exceed the update size limit", 400);

  const session = await cfJson<{ jwt?: string; buckets?: string[][] }>(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/assets-upload-session`,
    { method: "POST", body: JSON.stringify({ manifest }) },
  );
  let completionJwt = session.jwt || "";
  for (const bucket of session.buckets || []) {
    if (!Array.isArray(bucket) || bucket.length === 0) continue;
    if (!completionJwt) throw new UpdateError("Cloudflare did not return an asset upload token");
    const form = new FormData();
    for (const hash of bucket) {
      const found = hashes.get(hash);
      if (!found) throw new UpdateError("Cloudflare requested an unknown asset hash");
      const bytes = files.get(assetFileName(found.path));
      if (!bytes) throw new UpdateError(`Asset disappeared during upload: ${found.path}`);
      form.append(hash, new File([base64Bytes(bytes)], hash, { type: assetContentType(found.path) }));
    }
    const response = await fetch(`${CF_API}/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${completionJwt}` },
      body: form,
    });
    let body: { success?: boolean; result?: { jwt?: string }; errors?: Array<{ message?: string }> };
    try {
      body = await response.json() as typeof body;
    } catch {
      throw new UpdateError(`Cloudflare asset upload returned non-JSON response (HTTP ${response.status})`);
    }
    if (!response.ok || !body.success || !body.result?.jwt) {
      throw new UpdateError(body.errors?.[0]?.message || `Cloudflare asset upload failed (HTTP ${response.status})`);
    }
    completionJwt = body.result.jwt;
  }
  if (!completionJwt) throw new UpdateError("Cloudflare did not return a completed asset upload token");
  return completionJwt;
}

async function readActiveVersionId(token: string, accountId: string, script: string): Promise<string | null> {
  const result = await cfJson<unknown>(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`);
  type Deployment = { versions?: Array<{ version_id?: string; percentage?: number }> };
  const value = result as { deployments?: Deployment[] };
  const deployments: Deployment[] = Array.isArray(result) ? result as Deployment[] : value.deployments || [];
  for (const deployment of deployments) {
    const version = deployment.versions?.find((candidate) => candidate.percentage === 100) || deployment.versions?.[0];
    if (version?.version_id) return version.version_id;
  }
  return null;
}

async function readCrons(token: string, accountId: string, script: string): Promise<string[]> {
  const result = await cfJson<unknown>(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/schedules`);
  const rows = (result as { schedules?: Array<{ cron?: string }> }).schedules || [];
  return rows.map((row) => row.cron || "").filter(Boolean);
}

async function restoreCrons(token: string, accountId: string, script: string, crons: string[]): Promise<void> {
  if (crons.length === 0) return;
  await cfJson(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/schedules`, {
    method: "PUT",
    body: JSON.stringify(crons.map((cron) => ({ cron }))),
  });
}

async function ensureUpdateTables(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS autoupdate_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      operation_id TEXT,
      target_tag TEXT,
      target_version TEXT,
      version_id TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autoupdate_patches (
      patch_id TEXT PRIMARY KEY,
      release_version TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

export async function readUpdateState(db: D1Database): Promise<UpdateState | null> {
  await ensureUpdateTables(db);
  return db.prepare("SELECT status, operation_id, target_tag, target_version, version_id, error, started_at, updated_at FROM autoupdate_state WHERE id = 1")
    .first<UpdateState>();
}

async function acquireUpdateLock(db: D1Database, operationId: string, tag: string, version: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const expiredBefore = now - LOCK_TTL_SEC;
  const result = await db.prepare(`
    INSERT INTO autoupdate_state (id, status, operation_id, target_tag, target_version, version_id, error, started_at, updated_at)
    VALUES (1, 'resolving', ?, ?, ?, NULL, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'resolving', operation_id = excluded.operation_id,
      target_tag = excluded.target_tag, target_version = excluded.target_version,
      version_id = NULL, error = NULL, started_at = excluded.started_at,
      updated_at = excluded.updated_at
    WHERE autoupdate_state.status NOT IN ('resolving', 'downloading', 'patching', 'uploading', 'deploying')
       OR autoupdate_state.updated_at < ?
  `).bind(operationId, tag, version, now, now, expiredBefore).run();
  return result.meta.changes > 0;
}

async function updateState(db: D1Database, operationId: string, status: string, versionId: string | null = null, error: string | null = null): Promise<void> {
  await db.prepare("UPDATE autoupdate_state SET status = ?, version_id = COALESCE(?, version_id), error = ?, updated_at = ? WHERE id = 1 AND operation_id = ?")
    .bind(status, versionId, error, Math.floor(Date.now() / 1000), operationId).run();
}

async function applyPatch(db: D1Database, manifest: UpdateManifest, files: Map<string, Uint8Array>): Promise<boolean> {
  const patch = manifest.dbPatch;
  if (!patch) return false;
  if (patch.path !== "db/patch.sql") throw new UpdateError("Unsupported database patch path", 400);
  const bytes = files.get(patch.path);
  if (!bytes || bytes.byteLength > MAX_PATCH_BYTES) throw new UpdateError("Database patch is missing or too large", 400);
  const digest = await sha256(bytes);
  if (digest !== patch.sha256.toLowerCase()) throw new UpdateError("Database patch checksum mismatch", 400);
  const existing = await db.prepare("SELECT sha256 FROM autoupdate_patches WHERE patch_id = ?").bind(patch.id).first<{ sha256: string }>();
  if (existing) {
    if (existing.sha256 !== digest) throw new UpdateError("Database patch id was reused with different content", 409);
    return false;
  }
  const sql = new TextDecoder().decode(bytes).trim();
  if (!sql) throw new UpdateError("Database patch is empty", 400);
  if (/\b(PRAGMA|ATTACH|DETACH|VACUUM|DROP|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) throw new UpdateError("Database patch contains a forbidden statement", 400);
  const releaseVersion = manifest.version.replace(/'/g, "''");
  const patchId = patch.id.replace(/'/g, "''");
  const now = Math.floor(Date.now() / 1000);
  await db.exec(`BEGIN;\n${sql}\nINSERT INTO autoupdate_patches (patch_id, release_version, sha256, applied_at) VALUES ('${patchId}', '${releaseVersion}', '${digest}', ${now});\nCOMMIT;`);
  return true;
}

async function healthCheck(requestUrl: string, expectedVersion: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/edgesonic/version", requestUrl), {
      headers: { "Cache-Control": "no-store" },
    });
    if (!response.ok) return false;
    const body = await response.json() as { version?: string };
    return parseSemver(body.version || "")?.raw === parseSemver(expectedVersion)?.raw;
  } catch {
    return false;
  }
}

async function manifestForRelease(release: GithubRelease): Promise<{ manifest: UpdateManifest; artifact: GithubAsset }> {
  const manifestAsset = assetOf(release, UPDATE_MANIFEST_NAME);
  const artifact = assetOf(release, UPDATE_ARTIFACT_NAME);
  if (!manifestAsset || !artifact) throw new UpdateError("Selected release has no API-ready update package", 409);
  const bytes = await downloadBytes(manifestAsset.browser_download_url as string, 256 * 1024, "Update manifest");
  let manifest: UpdateManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as UpdateManifest;
  } catch {
    throw new UpdateError("Update manifest is invalid", 400);
  }
  const parsed = typeof manifest.version === "string" ? parseSemver(manifest.version) : null;
  const releaseVersion = parseSemver(release.tag_name || "");
  if (
    manifest.schema !== 1 ||
    !parsed ||
    !releaseVersion ||
    typeof manifest.tag !== "string" ||
    typeof manifest.artifact !== "string" ||
    typeof manifest.workerModule !== "string" ||
    typeof manifest.assetsManifest !== "string" ||
    compareSemver(parsed, releaseVersion) !== 0 ||
    normalizeTag(manifest.tag || "") !== normalizeTag(release.tag_name || "") ||
    manifest.artifact !== UPDATE_ARTIFACT_NAME
  ) {
    throw new UpdateError("Update manifest does not match the selected release", 400);
  }
  if (typeof manifest.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.artifactSha256)) {
    throw new UpdateError("Update manifest has no valid artifact checksum", 400);
  }
  if (manifest.dbPatch && (
    typeof manifest.dbPatch.id !== "string" ||
    manifest.dbPatch.path !== "db/patch.sql" ||
    typeof manifest.dbPatch.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(manifest.dbPatch.sha256)
  )) {
    throw new UpdateError("Update manifest has an invalid database patch", 400);
  }
  return { manifest, artifact };
}

export async function executeUpdate(
  env: Env,
  requestUrl: string,
  requestedTag: string | undefined,
  confirmMajor: boolean,
): Promise<Record<string, unknown>> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!token || !accountId) throw new UpdateError("CF_API_TOKEN / CF_ACCOUNT_ID not configured", 400);
  await ensureUpdateTables(env.DB);

  const current = await currentVersion(env, requestUrl);
  const releases = await githubReleases(env);
  const stable = releases
    .filter((release) => {
      const version = parseSemver(release.tag_name || "");
      return !release.prerelease && !!version && !version.prerelease && hasUpdateArtifact(release);
    })
    .sort((a, b) => compareSemver(parseSemver(b.tag_name || "")!, parseSemver(a.tag_name || "")!))[0];
  const selectedTag = requestedTag ? normalizeTag(requestedTag) : stable?.tag_name;
  if (!selectedTag) throw new UpdateError("No stable release is available", 404);
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(selectedTag)) throw new UpdateError("Invalid release tag", 400);
  const release = await githubReleaseByTag(env, selectedTag, releases);
  const { manifest, artifact } = await manifestForRelease(release);
  const target = parseSemver(manifest.version);
  if (!target) throw new UpdateError("Selected release has an invalid version", 400);
  const policy = classifyVersionUpdate(current, target, manifest.allowMajorUpdate === true, confirmMajor);
  if (policy !== "ok") {
    const status = policy === "major-confirmation-required" ? 409 : 400;
    throw new UpdateError(policy, status);
  }

  const operationId = crypto.randomUUID();
  if (!(await acquireUpdateLock(env.DB, operationId, manifest.tag, manifest.version))) {
    throw new UpdateError("Another update is already running", 409);
  }

  const script = env.WORKER_NAME || "edgesonic";
  let previousVersionId: string | null = null;
  let deployedVersionId: string | null = null;
  try {
    await updateState(env.DB, operationId, "downloading");
    const archive = await downloadBytes(artifact.browser_download_url as string, MAX_ARTIFACT_BYTES, "Update artifact");
    if (await sha256(archive) !== manifest.artifactSha256.toLowerCase()) throw new UpdateError("Update artifact checksum mismatch", 400);
    const files = await unpackArtifact(archive);
    const worker = files.get(manifest.workerModule);
    if (!worker || worker.byteLength > MAX_WORKER_BYTES) throw new UpdateError("Update artifact has no valid Worker module", 400);
    const assets = JSON.parse(textFile(files, manifest.assetsManifest)) as AssetManifest;

    previousVersionId = await readActiveVersionId(token, accountId, script);
    const crons = await readCrons(token, accountId, script);
    await updateState(env.DB, operationId, "patching");
    const patchApplied = await applyPatch(env.DB, manifest, files);

    await updateState(env.DB, operationId, "uploading");
    const assetJwt = await uploadAssets(token, accountId, script, files, assets);
    const metadata = {
      main_module: manifest.workerModule,
      bindings: [
        { type: "plain_text", name: "WORKER_VERSION", text: manifest.version },
        { type: "plain_text", name: "EDGESONIC_VERSION", text: manifest.version },
        { type: "plain_text", name: "EDGESONIC_BUILD_TIME", text: manifest.buildTime },
        { type: "assets", name: "ASSETS" },
      ],
      keep_bindings: ["plain_text", "json", "secret_text", "secret_key", "kv_namespace", "d1", "r2_bucket", "durable_object_namespace", "images", "assets"],
      containers: [{ class_name: "Sandbox" }],
      compatibility_date: manifest.compatibilityDate || "2025-05-24",
      compatibility_flags: manifest.compatibilityFlags || ["nodejs_compat"],
      assets: { jwt: assetJwt },
      annotations: {
        "workers/message": `EdgeSonic ${manifest.version}`,
        "workers/tag": manifest.tag,
      },
    };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata");
    form.append(manifest.workerModule, new Blob([worker.buffer as ArrayBuffer], { type: "application/javascript+module" }), manifest.workerModule);
    const version = await cfMultipart<{ id?: string }>(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/versions`, form);
    if (!version.id) throw new UpdateError("Cloudflare did not return a Worker version id");
    deployedVersionId = version.id;
    await updateState(env.DB, operationId, "deploying", deployedVersionId);

    await cfJson(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`, {
      method: "POST",
      body: JSON.stringify({
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: deployedVersionId }],
      }),
    });
    if (!(await healthCheck(requestUrl, manifest.version))) {
      if (previousVersionId) {
        await cfJson(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`, {
          method: "POST",
          body: JSON.stringify({ strategy: "percentage", versions: [{ percentage: 100, version_id: previousVersionId }] }),
        });
      }
      throw new UpdateError("New Worker failed the version health check");
    }
    try {
      await restoreCrons(token, accountId, script, crons);
    } catch {
      // Direct version deployment normally preserves schedules; a failure to
      // restore them is surfaced as a warning without rolling back code.
    }
    await updateState(env.DB, operationId, "success", deployedVersionId);
    return {
      ok: true,
      operationId,
      tag: manifest.tag,
      version: manifest.version,
      versionId: deployedVersionId,
      previousVersionId,
      patchApplied,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateState(env.DB, operationId, "error", deployedVersionId, message.slice(0, 500));
    throw error;
  }
}
