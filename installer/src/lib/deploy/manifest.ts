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

// GitHub release asset bytes are served from a redirect chain that ends on
// release-assets.githubusercontent.com (an Azure Blob endpoint), confirmed
// live to send no Access-Control-Allow-Origin header — unlike api.github.com
// and raw.githubusercontent.com, which do. A plain browser fetch() of
// `browser_download_url` (or the api.github.com asset-by-id alias, which
// redirects to the same host) throws "Failed to fetch" with no further detail.
// relay/CONTRACT.md doesn't cover this host — it's scoped to api.cloudflare.com
// and R2's S3 endpoint only. Until the relay (or something else) adds a
// passthrough for it, this call fails in every real browser; the try/catch
// below exists to turn that opaque TypeError into an actionable message
// instead of pretending the request almost worked.
async function downloadBytes(url: string, maxBytes: number, label: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  } catch {
    throw new Error(
      `${label} download was blocked by the browser (likely missing CORS headers on GitHub's release asset storage — this isn't covered by the installer relay yet).`,
    );
  }
  if (!response.ok) throw new Error(`${label} download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length") || "0");
  if (length > maxBytes) throw new Error(`${label} is too large`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`${label} is too large`);
  return bytes;
}

export async function fetchManifestAndArtifact(release: GithubRelease): Promise<{ manifest: UpdateManifest; archive: Uint8Array }> {
  const manifestAsset = assetOf(release, UPDATE_MANIFEST_NAME);
  const artifactAsset = assetOf(release, UPDATE_ARTIFACT_NAME);
  if (!manifestAsset || !artifactAsset) {
    throw new DeployError("download", "Selected release has no browser-deployable update package");
  }
  const manifestBytes = await downloadBytes(manifestAsset.browser_download_url as string, MAX_MANIFEST_BYTES, "Update manifest");
  let manifest: UpdateManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as UpdateManifest;
  } catch {
    throw new DeployError("download", "Update manifest is not valid JSON");
  }
  const parsedVersion = typeof manifest.version === "string" ? parseSemver(manifest.version) : null;
  const releaseVersion = parseSemver(release.tag_name || "");
  if (
    manifest.schema !== 1 ||
    !parsedVersion ||
    !releaseVersion ||
    compareSemver(parsedVersion, releaseVersion) !== 0 ||
    normalizeTag(manifest.tag || "") !== normalizeTag(release.tag_name || "") ||
    manifest.artifact !== UPDATE_ARTIFACT_NAME ||
    typeof manifest.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(manifest.artifactSha256)
  ) {
    throw new DeployError("download", "Update manifest doesn't match the selected release");
  }

  const archive = await downloadBytes(artifactAsset.browser_download_url as string, MAX_ARTIFACT_BYTES, "Update artifact");
  const digest = await sha256Hex(archive);
  if (digest !== manifest.artifactSha256.toLowerCase()) {
    throw new DeployError("download", "Update artifact checksum mismatch");
  }
  return { manifest, archive };
}
