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

import { AwsClient } from "aws4fetch";
import type { Context } from "hono";
import { jsonResponse } from "./cors";
import { BodyTooLargeError, MAX_BODY_BYTES, readBodyWithLimit } from "./limits";

type RelayContext = Context<{ Bindings: Env }>;

interface VerifyKeysRequest {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Cloudflare account IDs are 32 lowercase hex chars; R2/S3 bucket names are a
// restricted charset. Validating both keeps the accountId that lands in the
// signed request's *hostname* (not just its path) from being anything but
// what it's supposed to be.
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const BUCKET_NAME_RE = /^[a-z0-9]([a-z0-9.-]{1,61}[a-z0-9])?$/;

function isVerifyKeysRequest(body: unknown): body is VerifyKeysRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.accountId === "string" &&
    typeof b.bucketName === "string" &&
    typeof b.accessKeyId === "string" &&
    typeof b.secretAccessKey === "string" &&
    b.accessKeyId.length > 0 &&
    b.secretAccessKey.length > 0
  );
}

// Deliberately generic: never echo upstream status text/body back to the
// client — S3-style error XML can carry signing internals (e.g. the
// canonical request) derived from the secret key.
function describeStatus(status: number): string {
  if (status === 403) return "Access denied — check the key pair and bucket name";
  if (status === 404) return "Bucket not found";
  if (status === 400) return "Bad request";
  return `Unexpected response (HTTP ${status})`;
}

export async function handleVerifyR2Keys(c: RelayContext): Promise<Response> {
  let raw: ArrayBuffer;
  try {
    raw = await readBodyWithLimit(c.req.raw, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return jsonResponse(c, 413, { ok: false, error: "Request body too large" });
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonResponse(c, 400, { ok: false, error: "Invalid JSON body" });
  }

  if (!isVerifyKeysRequest(parsed)) {
    return jsonResponse(c, 400, {
      ok: false,
      error: "Expected { accountId, bucketName, accessKeyId, secretAccessKey }",
    });
  }

  const { accountId, bucketName, accessKeyId, secretAccessKey } = parsed;
  if (!ACCOUNT_ID_RE.test(accountId)) {
    return jsonResponse(c, 400, { ok: false, error: "Invalid accountId" });
  }
  if (!BUCKET_NAME_RE.test(bucketName)) {
    return jsonResponse(c, 400, { ok: false, error: "Invalid bucketName" });
  }

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    region: "auto",
    service: "s3",
  });

  let upstream: Response;
  try {
    upstream = await client.fetch(
      `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`,
      { method: "HEAD" },
    );
  } catch {
    return jsonResponse(c, 200, {
      ok: false,
      status: 0,
      message: "Unable to reach the R2 endpoint with the provided credentials",
    });
  }

  if (upstream.status === 200) {
    return jsonResponse(c, 200, { ok: true });
  }
  return jsonResponse(c, 200, {
    ok: false,
    status: upstream.status,
    message: describeStatus(upstream.status),
  });
}
