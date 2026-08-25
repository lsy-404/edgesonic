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

//
// R2 is S3-compatible. To let the browser fetch R2 objects directly (bypassing
// the Worker sub-request bandwidth pool), we sign a short-lived URL using
// AWS Signature Version 4. The browser follows a 302 with no extra headers;
// the signature lives entirely in the query string.
//
// Reference: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
//
// Required env (Workers Secrets, NOT in wrangler.toml vars):
//   R2_ACCESS_KEY_ID   — S3 access key (R2 → Manage R2 API Tokens → Create)
//  R2_SECRET_ACCESS_KEY — S3 secret key
//   CF_ACCOUNT_ID      — Cloudflare account id (reused from the Cloudflare
//                         integration; pushed via Settings UI or
//                         `wrangler secret put CF_ACCOUNT_ID`)
//
// Region is hardcoded to "auto" — R2 ignores the region but SigV4 requires one.

import { buildAuthorizationHeader, hex, hmac, sha256Hex, uriEncode } from "./sigv4";

const SERVICE = "s3";
const REGION = "auto";

// ---- Presign ---------------------------------------------------------------

export interface PresignOpts {
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  ttlSec?: number; // default 300 (5 min), max 604800 (7 days)
}

/**
 * Build a presigned R2 S3 GET URL with SigV4. Only `host` is signed, so the
 * signature lives entirely in the query string and the browser can fetch the
 * URL with whatever Range it likes.
 */
export async function presignR2Get(opts: PresignOpts): Promise<string> {
  const ttl = Math.min(Math.max(opts.ttlSec ?? 300, 1), 604800);
  // per R2 docs. Path style (https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key})
  // generates signatures whose host header doesn't match what R2 verifies → 403.
  const host = `${opts.bucket}.${opts.accountId}.r2.cloudflarestorage.com`;
  // S3 canonical URI is the path with `/` not double-encoded (encodeSlash=false
  // for canonical URI per S3 spec, since R2 keys use `/` as separator).
  const objectPath = `/${opts.key}`;
  const canonicalUri = uriEncode(objectPath, false);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const credential = `${opts.accessKeyId}/${credentialScope}`;

  // GET (the official AWS SDK presign also signs host only by default). Signing
  // Range required the browser to send the exact same Range value we signed,
  // which <audio> does not guarantee — any mismatch 403'd the whole request.
  const signedHeaders = "host";

  // in the query string and use "UNSIGNED-PAYLOAD" as the canonical request
  // payload hash. Using sha256("") (empty body hash) instead 403s on R2.
  // Mirrors the AWS SDK v3 presign output.
  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttl),
    "X-Amz-SignedHeaders": signedHeaders,
  };

  // Canonical query string: keys sorted, uri-encoded.
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(queryParams[k])}`)
    .join("&");

  // Canonical headers: lowercase, trimmed, sorted, each "name:value\n".
  const canonicalHeaders = `host:${host.trim()}\n`;

  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // Signing key chain: HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")
  const kDate = await hmac(new TextEncoder().encode("AWS4" + opts.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  const finalQuery: Record<string, string> = { ...queryParams, "X-Amz-Signature": signature };
  const queryString = Object.keys(finalQuery)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(finalQuery[k])}`)
    .join("&");

  return `https://${host}${canonicalUri}?${queryString}`;
}

// ---- Credential health ------------------------------------------------------
// A locally valid signature does not prove R2 still accepts the credential.
// Probe R2 and cache the verdict without blocking the streaming hot path.

export interface R2CredentialCheck {
  ok: boolean;
  status: number;
}

/**
 * HeadBucket: the cheapest real probe of whether R2 currently accepts this
 * credential. Unlike GetObject, it doesn't depend on any object existing, so
 * a 401/403 here means the credential is rejected, not that a key is missing.
 */
export async function checkR2Credentials(opts: {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
}): Promise<R2CredentialCheck> {
  const host = `${opts.bucket}.${opts.accountId}.r2.cloudflarestorage.com`;
  const url = new URL(`https://${host}/`);
  const { authorization, amzDate, contentSha256 } = await buildAuthorizationHeader({
    method: "HEAD",
    url,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: REGION,
    service: SERVICE,
    payloadHash: "UNSIGNED-PAYLOAD",
  });
  const resp = await fetch(url.toString(), {
    method: "HEAD",
    headers: {
      Authorization: authorization,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": contentSha256,
      Host: host,
    },
  });
  return { ok: resp.ok, status: resp.status };
}

const HEALTH_TTL_MS = 60_000;
let health: { ok: boolean; checkedAt: number } | null = null;

/**
 * Stale-while-revalidate gate for the presign hot path: never blocks the
 * caller on a live probe. A fresh isolate assumes healthy (zero added
 * latency) while a background check runs; only a confirmed-bad result, cached
 * for HEALTH_TTL_MS, turns later calls away from presign before they're handed
 * a URL R2 will reject. Bounds the blast radius of a bad credential to roughly
 * one request per isolate instead of every request until a human notices.
 */
export function isR2PresignHealthy(
  opts: { bucket: string; accessKeyId: string; secretAccessKey: string; accountId: string },
  ctx?: { waitUntil?: (p: Promise<unknown>) => void },
): boolean {
  const now = Date.now();
  const stale = !health || now - health.checkedAt >= HEALTH_TTL_MS;
  // A background probe must be attached to the request lifecycle.
  // Without waitUntil, leave the current cached verdict unchanged.
  if (stale && ctx?.waitUntil) {
    const checking = checkR2Credentials(opts)
      .then(({ ok, status }) => {
        health = { ok, checkedAt: Date.now() };
        if (!ok) {
          console.error(`[r2presign] R2 rejected the stored credential (HTTP ${status}) — falling back to the R2 binding until the next check`);
        }
      })
      .catch((err) => {
        health = { ok: false, checkedAt: Date.now() };
        console.error("[r2presign] credential health probe failed — falling back to the R2 binding:", err);
      });
    ctx.waitUntil(checking);
  }
  return health ? health.ok : true;
}

/** Test-only: clear the cached verdict so each scenario starts unknown. */
export function resetR2PresignHealthForTesting(): void {
  health = null;
}
