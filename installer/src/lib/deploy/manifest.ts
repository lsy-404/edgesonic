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

export type ByteProgress = (loaded: number, total: number) => void;

async function downloadBytes(url: string, maxBytes: number, label: string, onProgress?: ByteProgress): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchGithubReleaseAsset(url);
  } catch {
    throw new Error(`${label} download could not reach the installer relay`);
  }
  if (!response.ok) throw new Error(`${label} download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length") || "0");
  if (length > maxBytes) throw new Error(`${label} is too large`);
  // Read the body in chunks so a slow download can report real progress
  // instead of sitting on an indeterminate spinner. Without a content-length
  // there is nothing to divide by, so fall back to the buffered read.
  if (onProgress && length > 0 && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      loaded += value.byteLength;
      if (loaded > maxBytes) throw new Error(`${label} is too large`);
      chunks.push(value);
      onProgress(loaded, length);
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
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

export async function fetchManifestAndArtifact(release: GithubRelease, onProgress?: ByteProgress): Promise<{ manifest: UpdateManifest; archive: Uint8Array }> {
  const manifestAsset = assetOf(release, UPDATE_MANIFEST_NAME);
  const artifactAsset = assetOf(release, UPDATE_ARTIFACT_NAME);
  if (!manifestAsset || !artifactAsset) {
    throw new DeployError("download", "Selected release has no browser-deployable update package");
  }
  // Only the artifact is worth tracking — the manifest beside it is under a kilobyte.
  const manifestBytes = await downloadBytes(manifestAsset.browser_download_url as string, MAX_MANIFEST_BYTES, "Update manifest");
  const archive = await downloadBytes(artifactAsset.browser_download_url as string, MAX_ARTIFACT_BYTES, "Update artifact", onProgress);
  return validateManifestAndArtifact(manifestBytes, archive, release.tag_name);
}
