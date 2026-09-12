// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

const R2_COPY_RETRY_DELAYS_MS = [100, 250];

export interface R2CopyEnv {
  MUSIC_BUCKET: R2Bucket;
}

async function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function copyR2Object(
  env: R2CopyEnv,
  sourceKey: string,
  destKey: string,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= R2_COPY_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const object = await env.MUSIC_BUCKET.get(sourceKey);
      if (!object || !object.body) return false;
      await env.MUSIC_BUCKET.put(destKey, object.body.pipeThrough(new FixedLengthStream(object.size)), {
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
