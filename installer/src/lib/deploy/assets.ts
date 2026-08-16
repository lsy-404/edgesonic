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

export async function uploadAssets(
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
      form.append(hash, base64Bytes(bytes));
    }
    const result = await callCfMultipart<{ jwt?: string }>(
      completionJwt,
      `/accounts/${accountId}/workers/assets/upload?base64=true`,
      form,
      "Workers Scripts Edit",
    );
    if (result.jwt) completionJwt = result.jwt;
  }
  if (!completionJwt) throw new Error("Cloudflare did not return a completed asset upload token");
  return completionJwt;
}
