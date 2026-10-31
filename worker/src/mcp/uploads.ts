// SPDX-License-Identifier: AGPL-3.0-or-later
import { withMcpPrincipal, type McpPrincipal } from "./context";
import { operationResponse, McpOperationError, type AppDispatch } from "./operations";
import { hasPermission } from "../utils/permissions";
import { isDemoMode } from "../utils/demoMode";

export interface UploadInput {
  name: string; path?: string; source?: "r2" | "webdav";
  conflict?: "error" | "overwrite" | "rename"; size: number; contentType?: string;
}
interface UploadTicket {
  owner: string; expiresAt: number; input: UploadInput;
  state: "pending" | "uploading" | "completed" | "failed";
  result?: Record<string, unknown>;
}
const prefix = "mcp:upload:";
const lifetime = 60 * 60;

async function authorizeOverwrite(env: Env, principal: McpPrincipal, input: UploadInput) {
  if (input.conflict === "overwrite" && (!principal.scopes.includes("mcp:delete") || principal.user.level < 2 || isDemoMode(env) || !(await hasPermission(env, principal.user, "delete")))) {
    throw new McpOperationError("Overwriting requires separately granted deletion access", 403);
  }
}

export async function createUpload(env: Env, principal: McpPrincipal, origin: string, input: UploadInput) {
  await authorizeOverwrite(env, principal, input);
  if (!input.name || /[\\/\x00-\x1f\x7f]/.test(input.name) || [".", ".."].includes(input.name)) throw new McpOperationError("Invalid filename");
  if (input.path && (input.path.includes("\\") || /[\x00-\x1f\x7f]/.test(input.path) || input.path.split("/").some(p => p === "." || p === ".."))) throw new McpOperationError("Invalid upload path");
  const uploadId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const ticket: UploadTicket = { owner: principal.user.username, expiresAt: now + lifetime, state: "pending", input };
  await env.DB.prepare("DELETE FROM kv_store WHERE key LIKE 'mcp:upload:%' AND json_extract(value, '$.expiresAt') < ?").bind(now).run();
  await env.DB.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)").bind(prefix + uploadId, JSON.stringify(ticket), now).run();
  return { uploadId, uploadUrl: new URL(`/mcp/upload/${uploadId}`, origin).href, method: "PUT", expiresAt: ticket.expiresAt };
}

async function ticketFor(env: Env, principal: McpPrincipal, id: string): Promise<UploadTicket> {
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(prefix + id).first<{ value: string }>();
  if (!row) throw new McpOperationError("Upload not found", 404);
  const ticket: UploadTicket = JSON.parse(row.value);
  if (ticket.owner !== principal.user.username) throw new McpOperationError("Upload not found", 404);
  if (ticket.expiresAt <= Math.floor(Date.now() / 1000)) throw new McpOperationError("Upload ticket expired", 410);
  return ticket;
}

export async function finishUpload(env: Env, principal: McpPrincipal, id: string) {
  const ticket = await ticketFor(env, principal, id);
  if (ticket.state !== "completed") throw new McpOperationError(`Upload ${ticket.state}`, 409, ticket.result);
  return { ...ticket.result, uploadId: id };
}

export async function receiveUpload(request: Request, env: Env, ctx: ExecutionContext, principal: McpPrincipal, dispatch: AppDispatch): Promise<Response> {
  if (request.method !== "PUT") return Response.json({ ok: false, error: "Use PUT" }, { status: 405 });
  const id = new URL(request.url).pathname.slice("/mcp/upload/".length);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new McpOperationError("Upload not found", 404);
  const ticket = await ticketFor(env, principal, id);
  await authorizeOverwrite(env, principal, ticket.input);
  if (ticket.state !== "pending") throw new McpOperationError(`Upload ${ticket.state}`, 409);
  if (!request.body || request.headers.get("Content-Length") !== String(ticket.input.size)) throw new McpOperationError("Content-Length must match the upload ticket", 411);
  const claim = await env.DB.prepare("UPDATE kv_store SET value = json_set(value, '$.state', 'uploading') WHERE key = ? AND json_extract(value, '$.state') = 'pending'").bind(prefix + id).run();
  if (claim.meta.changes !== 1) throw new McpOperationError("Upload already in progress", 409);
  const url = new URL("/storage/files/upload", request.url);
  url.searchParams.set("name", ticket.input.name);
  url.searchParams.set("path", ticket.input.path || "");
  url.searchParams.set("source", ticket.input.source || "r2");
  url.searchParams.set("conflict", ticket.input.conflict || "error");
  url.searchParams.set("metadata", "direct");
  const headers = new Headers({ "Content-Length": String(ticket.input.size), "Content-Type": ticket.input.contentType || "application/octet-stream" });
  let result: Record<string, unknown>;
  let status = 200;
  try {
    const forwarded = new Request(url, { method: "POST", headers, body: request.body, duplex: "half" } as RequestInit);
    result = await operationResponse(await dispatch(forwarded, withMcpPrincipal(env, principal), ctx));
    ticket.state = "completed";
  } catch (error) {
    ticket.state = "failed";
    status = error instanceof McpOperationError ? error.status : 502;
    result = { ok: false, error: error instanceof Error ? error.message : "Upload failed", ...(error instanceof McpOperationError && error.details ? { details: error.details } : {}) };
  }
  ticket.result = result;
  await env.DB.prepare("UPDATE kv_store SET value = ?, updated_at = ? WHERE key = ?").bind(JSON.stringify(ticket), Math.floor(Date.now() / 1000), prefix + id).run();
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
}
