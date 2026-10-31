import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { libraryMcpDispatcher } from "../../worker/src/mcp/server";
import { isMcpOperationAllowed, type AppDispatch } from "../../worker/src/mcp/operations";
import { createUpload, receiveUpload, finishUpload } from "../../worker/src/mcp/uploads";
import { mcpPrincipal, type McpPrincipal } from "../../worker/src/mcp/context";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE storage_objects (id TEXT PRIMARY KEY, physical_key TEXT, suffix TEXT, content_type TEXT, size INTEGER);
    CREATE TABLE storage_entries (id TEXT PRIMARY KEY, source_id TEXT, parent_id TEXT, path TEXT, display_name TEXT, kind TEXT, object_id TEXT, instance_id TEXT, companion_of TEXT, created_at INTEGER, updated_at INTEGER, UNIQUE(source_id,path));
    INSERT INTO storage_objects VALUES ('object','objects/audio.flac','flac','audio/flac',4);
    INSERT INTO storage_entries VALUES ('first','r2-local',NULL,'music/first.flac','first.flac','file','object','instance',NULL,0,0);
    INSERT INTO storage_entries VALUES ('second','r2-local',NULL,'music/second.flac','second.flac','file','object','instance',NULL,0,0);`);
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = sqlite.prepare(sql);
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() { return statement.get(...values as never[]) ?? null; },
        async all() { return { results: statement.all(...values as never[]), success: true }; },
        async run() { return { meta: { changes: Number(statement.run(...values as never[]).changes) }, success: true }; },
      };
    },
  };
  const env = { DB: db, INSTANCE_ID: "test", PERMISSIONS_OVERRIDE: "{}" } as unknown as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const principal = { user: { username: "owner", enabled: 1, level: 3 }, scopes: ["mcp:read", "mcp:write", "mcp:upload"] } as McpPrincipal;
  return { sqlite, env, ctx, principal };
}

async function rpc(handler: ReturnType<typeof libraryMcpDispatcher>, f: ReturnType<typeof fixture>, method: string, params?: unknown) {
  const response = await handler(new Request("https://example.com/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  }), f.env, f.ctx, f.principal);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const json = body.startsWith("{") ? JSON.parse(body) : JSON.parse(body.split("\n").filter(line => line.startsWith("data: ")).at(-1)!.slice(6));
  return json;
}

test("management tools expose only granted operations and preserve write-back results", async () => {
  const f = fixture();
  const calls: Array<{ path: string; body: unknown }> = [];
  const app: AppDispatch = async (request, env) => {
    assert.equal(request.headers.get("Authorization"), null);
    assert.equal(request.headers.get("Cookie"), null);
    assert.equal(mcpPrincipal(env)?.user.username, "owner");
    const path = new URL(request.url).pathname;
    calls.push({ path, body: request.method === "POST" ? await request.json() : null });
    return Response.json({ ok: true, files: [{ instanceId: "instance", written: false, reason: "format not rewritable" }] });
  };
  const handler = libraryMcpDispatcher(app);
  const tools = await rpc(handler, f, "tools/list");
  assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === "update_metadata"));
  assert.ok(!tools.result.tools.some((tool: { name: string }) => tool.name.startsWith("delete_")));
  const forbidden = await rpc(handler, f, "tools/call", { name: "delete_file", arguments: { path: "music/second.flac" } });
  assert.ok(forbidden.error || forbidden.result?.isError);
  assert.equal(calls.length, 0);
  const written = await rpc(handler, f, "tools/call", { name: "update_metadata", arguments: { id: "song", tags: { title: "New title" } } });
  assert.equal(written.result.isError, undefined);
  assert.equal(written.result.structuredContent.files[0].written, false);
  assert.equal(calls[0].path, "/tag/write");
  assert.deepEqual(calls[0].body, { id: "song", tags: { title: "New title" } });
  const preview = await rpc(handler, f, "tools/call", { name: "organize_files", arguments: { ids: ["song"], template: "{album}/{title}" } });
  assert.ok(!preview.error);
  assert.equal((calls[1].body as { dryRun: boolean }).dryRun, true);
  f.principal.scopes = ["mcp:read"];
  const readonly = await rpc(handler, f, "tools/list");
  assert.ok(!readonly.result.tools.some((tool: { name: string }) => tool.name === "update_metadata"));
  assert.equal(isMcpOperationAllowed("POST", "/edgesonic/users/create", ["mcp:write", "mcp:delete"]), false);
  assert.equal(isMcpOperationAllowed("POST", "/storage/files/delete", ["mcp:write"]), false);
  f.sqlite.close();
});

test("moving a logical alias keeps other references to the same object intact", async () => {
  const f = fixture();
  const handler = libraryMcpDispatcher(() => { throw new Error("Logical move must not select an arbitrary physical-key match"); });
  const result = await rpc(handler, f, "tools/call", { name: "move_file", arguments: { path: "music/second.flac", dest: "renamed.flac" } });
  assert.equal(result.result.isError, undefined, JSON.stringify(result));
  assert.equal(f.sqlite.prepare("SELECT path FROM storage_entries WHERE id='first'").get()?.path, "music/first.flac");
  assert.equal(f.sqlite.prepare("SELECT path FROM storage_entries WHERE id='second'").get()?.path, "renamed.flac");
  f.sqlite.close();
});

test("upload tickets stream once, enforce ownership and expiry, and guard overwrite", async () => {
  const f = fixture();
  await assert.rejects(createUpload(f.env, f.principal, "https://example.com", { name: "song.flac", size: 4, conflict: "overwrite" }), /separately granted/);
  const ticket = await createUpload(f.env, f.principal, "https://example.com", { name: "song.flac", size: 4, path: "music" });
  assert.equal(new URL(ticket.uploadUrl).pathname, `/mcp/upload/${ticket.uploadId}`);
  const request = () => new Request(ticket.uploadUrl, { method: "PUT", headers: { "Content-Length": "4" }, body: "fLaC" });
  let calls = 0;
  const app: AppDispatch = async (request, env) => {
    calls++;
    assert.equal(new URL(request.url).pathname, "/storage/files/upload");
    assert.equal(new URL(request.url).searchParams.get("metadata"), "direct");
    assert.equal(await request.text(), "fLaC");
    assert.equal(mcpPrincipal(env)?.user.username, "owner");
    return Response.json({ ok: true, id: "instance", storageUri: "r2://song.flac", uploadNonce: "nonce", metadataStatus: "direct" });
  };
  const other = { ...f.principal, user: { ...f.principal.user, username: "other" } };
  await assert.rejects(receiveUpload(request(), f.env, f.ctx, other, app), /not found/);
  await assert.rejects(finishUpload(f.env, f.principal, ticket.uploadId), /pending/);
  assert.equal((await receiveUpload(request(), f.env, f.ctx, f.principal, app)).status, 200);
  const finished = await finishUpload(f.env, f.principal, ticket.uploadId);
  assert.equal(finished.id, "instance");
  assert.equal(finished.uploadNonce, undefined);
  await assert.rejects(receiveUpload(request(), f.env, f.ctx, f.principal, app), /completed/);
  assert.equal(calls, 1);
  const expired = await createUpload(f.env, f.principal, "https://example.com", { name: "song.flac", size: 4 });
  f.sqlite.prepare("UPDATE kv_store SET value=json_set(value,'$.expiresAt',0) WHERE key=?").run(`mcp:upload:${expired.uploadId}`);
  await assert.rejects(finishUpload(f.env, f.principal, expired.uploadId), /expired/);
  const conflict = await createUpload(f.env, { ...f.principal, scopes: [...f.principal.scopes, "mcp:delete"] }, "https://example.com", { name: "song.flac", size: 4, conflict: "overwrite" });
  await assert.rejects(receiveUpload(new Request(conflict.uploadUrl, { method: "PUT", headers: { "Content-Length": "4" }, body: "fLaC" }), f.env, f.ctx, f.principal, app), /separately granted/);
  f.sqlite.close();
});

test("cloud metadata HTTP input is bounded and origin checked", async () => {
  const f = fixture();
  const handler = libraryMcpDispatcher(() => new Response("unused"));
  const oversized = await handler(new Request("https://example.com/mcp/metadata/search", { method: "POST", body: "x".repeat(16001) }), f.env, f.ctx, f.principal);
  assert.equal(oversized.status, 413);
  const crossOrigin = await handler(new Request("https://example.com/mcp", { method: "POST", headers: { Origin: "https://untrusted.example" }, body: "{}" }), f.env, f.ctx, f.principal);
  assert.equal(crossOrigin.status, 403);
  f.sqlite.close();
});
