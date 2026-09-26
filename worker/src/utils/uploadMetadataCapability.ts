// SPDX-License-Identifier: AGPL-3.0-or-later

import { signUploadToken, verifyUploadToken } from "./workUploadToken";

const TOKEN_TTL_SECONDS = 30 * 60;

function subject(username: string, instanceId: string, storageUri: string, uploadNonce: string): string {
  return `manual-upload-metadata:${username}:${instanceId}:${storageUri}:${uploadNonce}`;
}

export async function issueUploadMetadataCapability(
  env: Env,
  username: string,
  instanceId: string,
  storageUri: string,
  uploadNonce: string,
): Promise<string | null> {
  if (!env.WORK_UPLOAD_HMAC_KEY) return null;
  return signUploadToken(env, subject(username, instanceId, storageUri, uploadNonce), TOKEN_TTL_SECONDS);
}

export async function verifyUploadMetadataCapability(
  env: Env,
  username: string,
  instanceId: string,
  storageUri: string,
  uploadNonce: string,
  token: string,
): Promise<boolean> {
  if (!env.WORK_UPLOAD_HMAC_KEY) return false;
  return (await verifyUploadToken(env, subject(username, instanceId, storageUri, uploadNonce), token)).ok;
}
