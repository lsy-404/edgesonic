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

// Every Cloudflare API call this app makes goes through this Worker's own
// /cf and /r2 routes (see worker/index.ts, CONTRACT.md) — api.cloudflare.com
// sends no CORS headers, so a direct browser call would fail regardless of
// the token's validity.

export class CfApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly context?: string,
  ) {
    super(message);
    this.name = "CfApiError";
  }
}

// Empty (the default) means same-origin relative calls — this Worker serves
// both the built frontend and these routes. Only set VITE_RELAY_URL when the
// frontend is deployed separately from the Worker it talks to.
function relayBase(): string {
  const url = (import.meta.env.VITE_RELAY_URL || "").trim();
  return url.replace(/\/+$/, "");
}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

// A network-level failure (relay unreachable, DNS, TLS, offline) surfaces
// from fetch() as a bare `TypeError: Failed to fetch` with no further detail
// — same generic message a CORS block would produce, but there's no relay
// call site where CORS is the culprit (the relay itself sets permissive
// headers). Naming the relay URL turns that dead end into something
// actionable instead of leaving the browser's own wording on screen.
async function fetchRelay(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new CfApiError(`Couldn't reach the installer relay at ${url.replace(/\/(cf|r2)\/.*$/, "")} — check your connection or that the relay is deployed.`, 0);
  }
}

/**
 * Calls `RELAY_URL/cf/<path>` with the given bearer token. `token` isn't
 * always the Account API Token — the asset upload completion call reuses
 * this same helper with the short-lived JWT the upload session returns, per
 * CONTRACT.md §1's note that the relay forwards whatever bearer it's
 * handed.
 */
export async function callCfJson<T>(
  token: string,
  path: string,
  init?: RequestInit,
  context?: string,
): Promise<T> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  let body: CfEnvelope<T>;
  try {
    body = (await response.json()) as CfEnvelope<T>;
  } catch {
    throw new CfApiError(`Cloudflare returned a non-JSON response (HTTP ${response.status})`, response.status, undefined, context);
  }
  if (!response.ok || !body.success) {
    const first = body.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
  return body.result as T;
}

/** Multipart variant for the Worker version upload and the asset-upload-session completion call. */
export async function callCfMultipart<T>(
  token: string,
  path: string,
  form: FormData,
  context?: string,
): Promise<T> {
  const response = await fetchRelay(`${relayBase()}/cf${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let body: CfEnvelope<T>;
  try {
    body = (await response.json()) as CfEnvelope<T>;
  } catch {
    throw new CfApiError(`Cloudflare returned a non-JSON response (HTTP ${response.status})`, response.status, undefined, context);
  }
  if (!response.ok || !body.success) {
    const first = body.errors?.[0];
    throw new CfApiError(first?.message || `Cloudflare request failed (HTTP ${response.status})`, response.status, first?.code, context);
  }
  return body.result as T;
}

export interface R2VerifyParams {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2VerifyResult {
  ok: boolean;
  status?: number;
  message?: string;
}

/** CONTRACT.md §2 — signs a HEAD against the bucket, doesn't touch api.cloudflare.com. */
export async function verifyR2Keys(params: R2VerifyParams): Promise<R2VerifyResult> {
  const base = relayBase();
  let response: Response;
  try {
    response = await fetch(`${base}/r2/verify-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch {
    return { ok: false, message: `Couldn't reach the installer relay at ${base} — check your connection or that the relay is deployed.` };
  }
  try {
    return (await response.json()) as R2VerifyResult;
  } catch {
    return { ok: false, status: response.status, message: "The relay returned a non-JSON response" };
  }
}
