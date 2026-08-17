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

import {
  assetOf,
  compareSemver,
  normalizeTag,
  parseSemver,
  UPDATE_ARTIFACT_NAME,
  UPDATE_MANIFEST_NAME,
  type GithubRelease,
} from "../../../../shared/autoupdate";
import { sha256Hex } from "./crypto";
import { DeployError } from "./types";
import { fetchGithubReleaseAsset } from "../relay";
import { unpackArtifact } from "./tar";

const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

export interface UpdateManifest {
  schema: 1;
  tag: string;
  version: string;
  buildTime: string;
  artifact: string;
  artifactSha256: string;
  workerModule: string;
  assetsManifest: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
}

export interface LocalUpdatePackage {
  kind: "local";
  fileName: string;
  manifest: UpdateManifest;
  archive: Uint8Array;
}

async function downloadBytes(url: string, maxBytes: number, label: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchGithubReleaseAsset(url);
  } catch {
    throw new Error(`${label} download could not reach the installer relay`);
  }
  if (!response.ok) throw new Error(`${label} download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length") || "0");
  if (length > maxBytes) throw new Error(`${label} is too large`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`${label} is too large`);
  return bytes;
}

async function validateManifestAndArtifact(manifestBytes: Uint8Array, archive: Uint8Array, expectedTag?: string): Promise<{ manifest: UpdateManifest; archive: Uint8Array }> {
  let manifest: UpdateManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as UpdateManifest;
  } catch {
    throw new DeployError("download", "Update manifest is not valid JSON");
  }
  const parsedVersion = typeof manifest.version === "string" ? parseSemver(manifest.version) : null;
  const expectedVersion = expectedTag ? parseSemver(expectedTag) : parsedVersion;
  if (
    manifest.schema !== 1 ||
    !parsedVersion ||
    !expectedVersion ||
    compareSemver(parsedVersion, expectedVersion) !== 0 ||
    normalizeTag(manifest.tag || "") !== normalizeTag(expectedTag || manifest.tag || "") ||
    manifest.artifact !== UPDATE_ARTIFACT_NAME ||
    typeof manifest.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(manifest.artifactSha256)
  ) {
    throw new DeployError("download", "Update manifest doesn't match the selected release");
  }
  if (archive.byteLength > MAX_ARTIFACT_BYTES) throw new DeployError("download", "Update artifact is too large");
  const digest = await sha256Hex(archive);
  if (digest !== manifest.artifactSha256.toLowerCase()) {
    throw new DeployError("download", "Update artifact checksum mismatch");
  }
  return { manifest, archive };
}

export async function fetchManifestAndArtifact(release: GithubRelease): Promise<{ manifest: UpdateManifest; archive: Uint8Array }> {
  const manifestAsset = assetOf(release, UPDATE_MANIFEST_NAME);
  const artifactAsset = assetOf(release, UPDATE_ARTIFACT_NAME);
  if (!manifestAsset || !artifactAsset) {
    throw new DeployError("download", "Selected release has no browser-deployable update package");
  }
  const manifestBytes = await downloadBytes(manifestAsset.browser_download_url as string, MAX_MANIFEST_BYTES, "Update manifest");
  const archive = await downloadBytes(artifactAsset.browser_download_url as string, MAX_ARTIFACT_BYTES, "Update artifact");
  return validateManifestAndArtifact(manifestBytes, archive, release.tag_name);
}

// A bare update artifact (no manifest wrapper, no signed checksum) — for a
// tar.gz built locally rather than pulled from a signed release. There's
// nothing external to validate the checksum against, so this only confirms
// the archive actually contains what the deploy pipeline expects to find.
export async function readLocalUpdateArtifact(file: File): Promise<LocalUpdatePackage> {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".tar.gz") && !lower.endsWith(".tgz")) {
    throw new DeployError("download", "Choose a .tar.gz update artifact");
  }
  if (file.size > MAX_ARTIFACT_BYTES) throw new DeployError("download", "Local artifact is too large");
  const archive = new Uint8Array(await file.arrayBuffer());
  let files: Map<string, Uint8Array>;
  try {
    files = await unpackArtifact(archive);
  } catch {
    throw new DeployError("download", "Local artifact is not a valid tar.gz update package");
  }
  if (!files.has("worker.js") || !files.has("assets-manifest.json")) {
    throw new DeployError("download", "Local artifact is missing worker.js or assets-manifest.json");
  }
  const manifest: UpdateManifest = {
    schema: 1,
    tag: "local",
    version: "0.0.0-local",
    buildTime: new Date().toISOString(),
    artifact: UPDATE_ARTIFACT_NAME,
    artifactSha256: await sha256Hex(archive),
    workerModule: "worker.js",
    assetsManifest: "assets-manifest.json",
  };
  return { kind: "local", fileName: file.name, manifest, archive };
}
