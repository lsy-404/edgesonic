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

import { buildAuthorizationHeader, uriEncode } from "./sigv4";

const R2_COPY_RETRY_DELAYS_MS = [100, 250];

export interface R2CopyEnv {
  MUSIC_BUCKET: R2Bucket;
  CF_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_COPY_ACCESS_KEY_ID?: string;
  R2_COPY_SECRET_ACCESS_KEY?: string;
}

export interface R2CopyRequestState {
  serverCopyUnavailable: boolean;
}

export function createR2CopyRequestState(): R2CopyRequestState {
  return { serverCopyUnavailable: false };
}

function r2CopyConfig(env: R2CopyEnv): {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
} | null {
  if (!env.R2_COPY_ACCESS_KEY_ID || !env.R2_COPY_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) return null;
  return {
    bucket: env.R2_BUCKET_NAME || "edgesonic-music",
    accountId: env.CF_ACCOUNT_ID,
    accessKeyId: env.R2_COPY_ACCESS_KEY_ID,
    secretAccessKey: env.R2_COPY_SECRET_ACCESS_KEY,
  };
}

async function copyWithS3(config: NonNullable<ReturnType<typeof r2CopyConfig>>, sourceKey: string, destKey: string): Promise<boolean> {
  const host = `${config.bucket}.${config.accountId}.r2.cloudflarestorage.com`;
  const url = new URL(`https://${host}${uriEncode(`/${destKey}`, false)}`);
  const copySource = uriEncode(`/${config.bucket}/${sourceKey}`, false);
  const extraHeaders = {
    "x-amz-copy-source": copySource,
    "x-amz-metadata-directive": "COPY",
  };
  const { authorization, amzDate, contentSha256 } = await buildAuthorizationHeader({
    method: "PUT",
    url,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: "auto",
    service: "s3",
    payloadHash: "UNSIGNED-PAYLOAD",
    extraHeaders,
  });
  const response = await fetch(url.toString(), {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": contentSha256,
      "x-amz-copy-source": copySource,
      "x-amz-metadata-directive": "COPY",
      Host: host,
    },
  });
  if (response.ok) return true;
  try { await response.body?.cancel(); } catch { /* best effort */ }
  return false;
}

async function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function copyWithBinding(bucket: R2Bucket, sourceKey: string, destKey: string): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= R2_COPY_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const object = await bucket.get(sourceKey);
      if (!object || !("body" in object) || !object.body) return false;
      await bucket.put(destKey, object.body.pipeThrough(new FixedLengthStream(object.size)), {
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
      });
      return true;
    } catch (error) {
      lastError = error;
      const delayMs = R2_COPY_RETRY_DELAYS_MS[attempt];
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /\b10001\b/.test(message) || (/internal error/i.test(message) && /try again/i.test(message));
      if (!retryable || delayMs === undefined) throw error;
      await waitForRetry(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function copyR2Object(
  env: R2CopyEnv,
  sourceKey: string,
  destKey: string,
  state: R2CopyRequestState = createR2CopyRequestState(),
): Promise<boolean> {
  const config = r2CopyConfig(env);
  if (config && !state.serverCopyUnavailable) {
    try {
      if (await copyWithS3(config, sourceKey, destKey)) return true;
    } catch { /* fall back to the binding copy below */ }
    state.serverCopyUnavailable = true;
  }
  return copyWithBinding(env.MUSIC_BUCKET, sourceKey, destKey);
}
