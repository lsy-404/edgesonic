// SPDX-License-Identifier: AGPL-3.0-or-later
import type { McpPrincipal } from "./context";
import { withMcpPrincipal } from "./context";

export type AppDispatch = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const routes: Record<string, string> = {
  "GET /rest/search3": "mcp:read",
  "GET /rest/getSong": "mcp:read",
  "GET /rest/getAlbum": "mcp:read",
  "GET /rest/getAlbumList2": "mcp:read",
  "GET /rest/getLyricsBySongId": "mcp:read",
  "GET /storage/files/list": "mcp:read",
  "GET /storage/files/song-locations": "mcp:read",
  "POST /storage/files/upload": "mcp:upload",
  "POST /tag/write": "mcp:write",
  "POST /tag/batchWrite": "mcp:write",
  "POST /tag/tidyFolder": "mcp:write",
  "POST /storage/files/move": "mcp:write",
  "POST /storage/files/moveFolder": "mcp:write",
  "POST /storage/files/mkdir": "mcp:write",
  "POST /storage/files/copy": "mcp:write",
  "POST /storage/files/delete": "mcp:delete",
  "POST /storage/files/deleteFolder": "mcp:delete",
};

export function isMcpOperationAllowed(method: string, pathname: string, scopes: readonly string[]): boolean {
  const scope = routes[`${method.toUpperCase()} ${pathname}`];
  return !!scope && scopes.includes(scope);
}

export class McpOperationError extends Error {
  constructor(message: string, readonly status = 400, readonly details?: unknown) { super(message); }
}

export async function operationResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.headers.get("Content-Type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new McpOperationError(`Operation returned HTTP ${response.status}`, response.ok ? 502 : response.status);
  }
  const data = await response.json<Record<string, unknown>>();
  const inner = data["subsonic-response"] as Record<string, unknown> | undefined;
  if (!response.ok || data.ok === false || inner?.status === "failed") {
    const error = (inner?.error ?? data.error) as string | { message?: string } | undefined;
    throw new McpOperationError(typeof error === "string" ? error : error?.message || `Operation failed: HTTP ${response.status}`, response.ok ? 400 : response.status, data);
  }
  return inner ?? data;
}

export function invokeOperation(
  dispatch: AppDispatch, origin: string, env: Env, ctx: ExecutionContext, principal: McpPrincipal,
  method: string, path: string, body?: unknown,
): Promise<Record<string, unknown>> {
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin || !isMcpOperationAllowed(method, url.pathname, principal.scopes)) {
    throw new McpOperationError("Operation not authorized", 403);
  }
  url.searchParams.set("f", "json");
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const request = new Request(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return Promise.resolve(dispatch(request, withMcpPrincipal(env, principal), ctx)).then(operationResponse);
}
