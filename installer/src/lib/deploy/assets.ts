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

// Ported from worker/src/utils/autoupdate.ts's uploadAssets — same two-phase
// session/bucket protocol, but every api.cloudflare.com call goes through the
// relay instead of a direct fetch. The completion call
// (workers/assets/upload) is authorized with the session's own JWT rather
// than the user's API token — CONTRACT.md §1 notes the relay forwards
// whatever bearer it's handed, so callCfMultipart just takes the JWT as its
// `token` argument for that one call.

import { callCfJson, callCfMultipart } from "../relay";
import { base64Bytes } from "./crypto";

const MAX_ASSET_BYTES = 16 * 1024 * 1024;

interface AssetEntry {
  hash: string;
  size: number;
}

export type AssetManifest = Record<string, AssetEntry>;

function assetFileName(assetPath: string): string {
  const clean = assetPath.replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.includes("\\")) throw new Error("Invalid asset path in update manifest");
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
    case "webmanifest": return "application/manifest+json";
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

export async function uploadAssets(
  token: string,
  accountId: string,
  script: string,
  files: Map<string, Uint8Array>,
  manifest: AssetManifest,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  const hashes = new Map<string, { path: string; entry: AssetEntry }>();
  let totalBytes = 0;
  for (const [assetPath, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry.hash !== "string" || !/^[0-9a-f]{32}$/i.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error("Invalid asset manifest");
    }
    const bytes = files.get(assetFileName(assetPath));
    if (!bytes || bytes.byteLength !== entry.size) throw new Error(`Asset is missing or has an invalid size: ${assetPath}`);
    totalBytes += bytes.byteLength;
    hashes.set(entry.hash, { path: assetPath, entry });
  }
  if (totalBytes > MAX_ASSET_BYTES) throw new Error("Static assets exceed the update size limit");

  const session = await callCfJson<{ jwt?: string; buckets?: string[][] }>(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/assets-upload-session`,
    { method: "POST", body: JSON.stringify({ manifest }) },
    "Workers Scripts Edit",
  );
  let completionJwt = session.jwt || "";
  const buckets = (session.buckets || []).filter((bucket) => Array.isArray(bucket) && bucket.length > 0);
  // Cloudflare only asks for hashes it doesn't already store, so progress is
  // measured against what it actually requested rather than the whole manifest.
  const bucketBytes = buckets.map((bucket) => bucket.reduce((sum, hash) => sum + (hashes.get(hash)?.entry.size || 0), 0));
  const requestedBytes = bucketBytes.reduce((sum, size) => sum + size, 0);
  let uploadedBytes = 0;
  onProgress?.(0, requestedBytes);
  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index];
    if (!Array.isArray(bucket) || bucket.length === 0) continue;
    if (!completionJwt) throw new Error("Cloudflare did not return an asset upload token");
    const form = new FormData();
    for (const hash of bucket) {
      const found = hashes.get(hash);
      if (!found) throw new Error("Cloudflare requested an unknown asset hash");
      const bytes = files.get(assetFileName(found.path));
      if (!bytes) throw new Error(`Asset disappeared during upload: ${found.path}`);
      form.append(hash, new File([base64Bytes(bytes)], hash, { type: assetContentType(found.path) }));
    }
    const result = await callCfMultipart<{ jwt?: string }>(
      completionJwt,
      `/accounts/${accountId}/workers/assets/upload?base64=true`,
      form,
      "Workers Scripts Edit",
    );
    if (result.jwt) completionJwt = result.jwt;
    uploadedBytes += bucketBytes[index];
    onProgress?.(uploadedBytes, requestedBytes);
  }
  if (!completionJwt) throw new Error("Cloudflare did not return a completed asset upload token");
  return completionJwt;
}
