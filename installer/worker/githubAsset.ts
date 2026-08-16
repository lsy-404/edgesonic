// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context } from "hono";
import { applyCorsHeaders, jsonResponse } from "./cors";

type RelayContext = Context<{ Bindings: Env }>;

const MAX_ASSET_BYTES = 24 * 1024 * 1024;

function isReleaseAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/releases\/download\//.test(url.pathname);
  } catch {
    return false;
  }
}

export async function handleGithubAsset(c: RelayContext): Promise<Response> {
  const url = c.req.query("url") || "";
  if (!isReleaseAssetUrl(url)) return jsonResponse(c, 400, { error: "Invalid GitHub release asset URL" });

  let upstream: Response;
  try {
    upstream = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  } catch {
    return jsonResponse(c, 502, { error: "Unable to download GitHub release asset" });
  }
  if (!upstream.ok || !upstream.body) return jsonResponse(c, upstream.status || 502, { error: "GitHub release asset download failed" });
  const length = Number(upstream.headers.get("content-length") || "0");
  if (length > MAX_ASSET_BYTES) return jsonResponse(c, 413, { error: "GitHub release asset is too large" });

  const headers = new Headers({ "Content-Type": upstream.headers.get("content-type") || "application/octet-stream" });
  if (length > 0) headers.set("Content-Length", String(length));
  applyCorsHeaders(c, headers);
  return new Response(upstream.body, { status: 200, headers });
}
