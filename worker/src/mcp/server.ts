// SPDX-License-Identifier: AGPL-3.0-or-later
import { McpServer, createMcpHandler, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpPrincipal } from "./context";
import { getEffectivePermissions } from "../utils/permissions";
import { findR2EntryByPath, updateR2EntryPath } from "../utils/storageResolver";
import { invokeOperation, McpOperationError, type AppDispatch } from "./operations";
import { createUpload, finishUpload, receiveUpload, submitUploadMetadata } from "./uploads";
import { searchMetadata, resolveMetadata } from "./metadata";

const id = z.string().min(1).max(200);
const path = z.string().min(1).max(2000);
const tags = z.object({
  title: z.string().max(1000).optional(), artist: z.string().max(1000).optional(),
  album: z.string().max(1000).optional(), albumArtist: z.string().max(1000).optional(),
  genre: z.string().max(1000).optional(), lyrics: z.string().max(64000).optional(),
  year: z.number().int().min(0).max(9999).optional(), track: z.number().int().min(0).optional(), disc: z.number().int().min(0).optional(),
}).strict();
const sources = z.array(z.enum(["lrc", "netease", "qmusic", "kugou"])).min(1).max(4).optional();
export const metadataSearchSchema = z.object({ query: z.string().trim().min(1).max(200), sources, limit: z.number().int().min(1).max(20).optional(), current: z.object({ title: z.string().max(200).optional(), artist: z.string().max(200).optional(), album: z.string().max(200).optional() }).strict().optional() }).strict();
export const metadataResolveSchema = z.object({ result: z.object({ source: z.enum(["lrc", "netease", "qmusic", "kugou"]), songId: id, title: z.string().max(500), artist: z.string().max(500) }).passthrough() }).strict();
export const uploadSchema = z.object({ name: z.string().min(1).max(255), path: z.string().max(2000).optional(), source: z.enum(["r2", "webdav"]).optional(), conflict: z.enum(["error", "overwrite", "rename"]).optional(), size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), contentType: z.string().max(150).optional() }).strict();

export async function createLibraryMcpServer(origin: string, env: Env, ctx: ExecutionContext, principal: McpPrincipal, dispatch: AppDispatch) {
  const server = new McpServer({ name: "edgesonic", version: "1.0.0" });
  const permissions = await getEffectivePermissions(env, principal.user);
  const api = (method: string, url: string, body?: unknown) => invokeOperation(dispatch, origin, env, ctx, principal, method, url, body);
  function tool<S extends z.ZodObject>(name: string, scope: string, required: string[], description: string, schema: S, run: (args: z.infer<S>) => Promise<Record<string, unknown>>, readOnly = false, destructive = false) {
    if (!principal.scopes.includes(scope) || required.some(p => !permissions[p])) return;
    const inputSchema: z.ZodObject = schema;
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: name.includes("metadata") } }, async (args: unknown): Promise<CallToolResult> => {
      try {
        const data = await run(schema.parse(args));
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        const data = { ok: false, error: error instanceof Error ? error.message : "Operation failed", ...(error instanceof McpOperationError ? { status: error.status, details: error.details } : {}) };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      }
    });
  }
  tool("search_library", "mcp:read", ["search"], "Search indexed tracks, albums and artists; results include IDs for metadata tools.", z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).default(0) }).strict(), async a => api("GET", `/rest/search3?${new URLSearchParams({ query: a.query, songCount: String(a.limit), songOffset: String(a.offset), albumCount: String(a.limit), artistCount: String(a.limit) })}`), true);
  tool("get_metadata", "mcp:read", ["browse"], "Read catalog metadata for a song or uploaded instance ID.", z.object({ id }).strict(), async a => {
    const instance = await env.DB.prepare("SELECT master_id FROM song_instances WHERE id = ?").bind(a.id).first<{ master_id: string }>();
    const data = await api("GET", `/rest/getSong?id=${encodeURIComponent(instance?.master_id || a.id)}&includeSources=true`);
    if (!data.song) throw new McpOperationError("Song not found", 404);
    return data;
  }, true);
  tool("get_album", "mcp:read", ["browse"], "Read an album and its tracks.", z.object({ id }).strict(), a => api("GET", `/rest/getAlbum?id=${encodeURIComponent(a.id)}`), true);
  tool("list_files", "mcp:read", ["download"], "List a directory on R2 or a configured WebDAV source. Paths identify logical entries.", z.object({ source: z.string().max(200).default("r2"), path: z.string().max(2000).default(""), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }).strict(), async a => {
    const data = await api("GET", `/storage/files/list?${new URLSearchParams({ source: a.source, path: a.path })}`);
    const entries: Record<string, unknown>[] = [...((data.dirs || []) as Record<string, unknown>[]).map(row => ({ ...row, kind: "folder" })), ...((data.files || []) as Record<string, unknown>[]).map(row => ({ ...row, kind: "file" }))];
    return { ...data, dirs: undefined, files: undefined, entries: entries.slice(a.offset, a.offset + a.limit).map(row => ({ ...row, path: [a.path.replace(/\/+$/, ""), row.name].filter(Boolean).join("/") })), total: entries.length, nextOffset: a.offset + a.limit < entries.length ? a.offset + a.limit : null };
  }, true);
  tool("get_song_files", "mcp:read", ["manage_files"], "Find logical file paths for a catalog song.", z.object({ id }).strict(), a => api("GET", `/storage/files/song-locations?songId=${encodeURIComponent(a.id)}`), true);
  tool("search_metadata_candidates", "mcp:read", ["edit_tags"], "Query metadata providers in the cloud without a browser worker. Returns candidates and provider errors; does not modify the library.", metadataSearchSchema, async a => ({ ...await searchMetadata(env, a) }), true);
  tool("resolve_metadata_candidate", "mcp:read", ["edit_tags"], "Resolve a provider candidate and lyrics in the cloud. Select fields explicitly with update_metadata to apply.", metadataResolveSchema, async a => ({ result: await resolveMetadata(env, a) }), true);
  tool("update_metadata", "mcp:write", ["edit_tags"], "Update catalog fields and attempt embedded tag writing. Inspect files[].written/reason separately from catalog success; embedded rewrites currently support MP3/FLAC up to 80 MiB on R2/WebDAV.", z.object({ id, tags, coverData: z.string().max(700000).optional(), coverMime: z.string().max(100).optional() }).strict(), a => api("POST", "/tag/write", a));
  tool("batch_update_metadata", "mcp:write", ["edit_tags"], "Apply the same tag patch to up to 50 songs; returns individual results.", z.object({ ids: z.array(id).min(1).max(50), tags }).strict(), a => api("POST", "/tag/batchWrite", a));
  tool("organize_files", "mcp:write", ["manage_files"], "Organize R2/WebDAV song files using a metadata template. Defaults to preview; set dryRun=false to apply. Returns per-instance skips and failures.", z.object({ ids: z.array(id).min(1).max(100), template: z.string().min(1).max(2000), source: z.enum(["r2", "webdav"]).optional(), dryRun: z.boolean().default(true) }).strict(), a => api("POST", "/tag/tidyFolder", a));
  tool("create_folder", "mcp:write", ["upload"], "Create a logical R2 folder.", z.object({ path }).strict(), a => api("POST", "/storage/files/mkdir", a));
  for (const name of ["move_file", "copy_file"] as const) tool(name, "mcp:write", ["upload"], `${name === "move_file" ? "Move or rename" : "Copy"} an R2 logical file; rejects destination conflicts.`, z.object({ path, dest: path }).strict(), async a => {
    const entry = await findR2EntryByPath(env.DB, a.path);
    if (!entry || entry.kind !== "file" || !entry.physical_key) throw new McpOperationError("File not found", 404);
    if (name === "copy_file") return api("POST", "/storage/files/copy", { key: entry.physical_key, dest: a.dest });
    if (/\\|[\x00-\x1f\x7f]/.test(a.dest) || a.dest.split("/").some(p => p === "." || p === "..")) throw new McpOperationError("Invalid destination");
    if (a.path === a.dest) return { ok: true };
    if (await findR2EntryByPath(env.DB, a.dest)) throw new McpOperationError("Destination already exists", 409);
    await updateR2EntryPath(env.DB, entry.id, a.dest);
    return { ok: true };
  });
  tool("move_folder", "mcp:write", ["upload"], "Move or rename a logical R2 directory.", z.object({ path, dest: path }).strict(), a => api("POST", "/storage/files/moveFolder", a));
  tool("create_upload", "mcp:upload", ["upload"], "Create an expiring upload ticket. PUT the original file bytes to uploadUrl using the same bearer token and exact Content-Length, then call finish_upload. Bytes do not belong in MCP JSON.", uploadSchema, a => createUpload(env, principal, origin, a));
  tool("finish_upload", "mcp:upload", ["upload"], "Read the stored upload result. A queued metadata status does not mean parsing is complete; submit local parsed tags or explicitly write retrieved fields.", z.object({ uploadId: id }).strict(), a => finishUpload(env, principal, a.uploadId));
  tool("submit_upload_metadata", "mcp:upload", ["upload"], "Apply parsed tags to this completed upload; does not rewrite the audio file.", z.object({ uploadId: id, tags: tags.extend({ duration: z.number().nonnegative().optional(), bitrate: z.number().nonnegative().optional(), sampleRate: z.number().nonnegative().optional(), channels: z.number().int().nonnegative().optional(), bitDepth: z.number().int().nonnegative().optional(), container: z.string().max(100).optional(), codec: z.string().max(100).optional() }) }).strict(), a => submitUploadMetadata(env, principal, a.uploadId, a.tags));
  if (principal.user.level >= 2) {
    tool("delete_file", "mcp:delete", ["delete"], "Permanently delete one R2 logical file and unreferenced data. Requires separately granted deletion access.", z.object({ path }).strict(), async a => {
      const entry = await findR2EntryByPath(env.DB, a.path);
      if (!entry || entry.kind !== "file" || !entry.physical_key) throw new McpOperationError("File not found", 404);
      return api("POST", "/storage/files/delete", { path: a.path, key: entry.physical_key });
    }, false, true);
    tool("delete_folder", "mcp:delete", ["delete"], "Permanently delete an R2 logical subtree. Requires separately granted deletion access; inspect partial failures.", z.object({ path }).strict(), a => api("POST", "/storage/files/deleteFolder", a), false, true);
  }
  return server;
}

export function libraryMcpDispatcher(dispatch: AppDispatch) {
  return async (request: Request, env: Env, ctx: ExecutionContext, principal: McpPrincipal): Promise<Response> => {
    const url = new URL(request.url);
    if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) return new Response("Origin not allowed", { status: 403 });
    try {
      if (url.pathname.startsWith("/mcp/upload/")) {
        if (!principal.scopes.includes("mcp:upload")) throw new McpOperationError("Upload not authorized", 403);
        const permissions = await getEffectivePermissions(env, principal.user);
        if (!permissions.upload) throw new McpOperationError("Upload not authorized", 403);
        return await receiveUpload(request, env, ctx, principal, dispatch);
      }
      if (url.pathname === "/mcp/metadata/search" || url.pathname === "/mcp/metadata/resolve") {
        const permissions = await getEffectivePermissions(env, principal.user);
        if (!principal.scopes.includes("mcp:read") || !permissions.edit_tags) throw new McpOperationError("Metadata retrieval not authorized", 403);
        if (request.method !== "POST") return new Response("Use POST", { status: 405 });
        const reader = request.body?.getReader();
        if (!reader) throw new McpOperationError("Missing JSON body");
        let size = 0;
        let raw = "";
        const decoder = new TextDecoder();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 16000) { await reader.cancel(); throw new McpOperationError("Metadata request too large", 413); }
            raw += decoder.decode(next.value, { stream: true });
          }
          raw += decoder.decode();
        } finally { reader.releaseLock(); }
        const input: unknown = JSON.parse(raw);
        const result = url.pathname.endsWith("/search") ? await searchMetadata(env, metadataSearchSchema.parse(input)) : { result: await resolveMetadata(env, metadataResolveSchema.parse(input)) };
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      const handler = createMcpHandler(() => createLibraryMcpServer(url.origin, env, ctx, principal, dispatch), { maxRequestBodySize: 1024 * 1024 });
      return await handler.fetch(request);
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "Operation failed" }, { status: error instanceof McpOperationError ? error.status : 400, headers: { "Cache-Control": "no-store" } });
    }
  };
}
