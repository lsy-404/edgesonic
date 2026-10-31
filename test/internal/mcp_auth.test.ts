import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash, randomBytes } from "node:crypto";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  return nextResolve(specifier, context);
} });


class MemoryKV {
  values = new Map<string, string>();
  async get(key: string, options?: { type?: string } | string) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return (typeof options === "string" ? options : options?.type) === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
  async list({ prefix = "" }: { prefix?: string } = {}) {
    return { keys: [...this.values.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true, cacheStatus: null };
  }
}

test("OAuth consent, scope, live admission and grant revocation", async () => {
  const { createMcpAuthHandler } = await import("../../worker/src/mcp/auth");
  const kv = new MemoryKV();
  let enabled = true;
  const db = { prepare(sql: string) {
    return { bind(..._args: unknown[]) { return this; }, async first() {
      if (sql.includes("FROM users")) return enabled ? { username: "tester", master_password: "x", level: 3, enabled: 1, activation_status: "permanent" } : null;
      return null;
    } };
  } };
  const env = { DB: db, MCP_OAUTH_KV: kv, INSTANCE_ID: "test" } as unknown as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const app = async (req: Request) => {
    if (new URL(req.url).pathname !== "/edgesonic/auth/me") return new Response("not found", { status: 404 });
    if (!req.headers.get("Cookie")?.includes("edgesonic_session=valid")) return new Response("unauthorized", { status: 401 });
    return Response.json({ ok: true, username: "tester", level: 3, authSource: "local", activation: { active: true } });
  };
  const handler = createMcpAuthHandler(app, async (_req, _env, _ctx, principal) => Response.json({ scopes: principal.scopes }));
  const request = (path: string, init?: RequestInit) => handler(new Request(`https://example.com${path}`, init), env, ctx);
  assert.equal((await request("/edgesonic/mcp/grants?apiKey=subsonic-key")).status, 401);
  const registration = await request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test client", redirect_uris: ["http://127.0.0.1:4321/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  assert.equal(registration.status, 201, await registration.clone().text());
  const { client_id } = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://127.0.0.1:4321/callback", scope: "mcp:read mcp:write mcp:delete", state: "state", code_challenge: challenge, code_challenge_method: "S256", resource: "https://example.com/mcp" });
  const consent = await request(`/authorize?${params}`, { headers: { Cookie: "edgesonic_session=valid" } });
  assert.equal(consent.status, 200, await consent.clone().text());
  const page = await consent.text();
  assert.match(page, /value="mcp:delete">/);
  const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(handle);
  const cookie = consent.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.ok(cookie);
  const form = new URLSearchParams({ handle, decision: "approve" });
  form.append("scope", "mcp:read"); form.append("scope", "mcp:write");
  const forged = await request("/authorize", { method: "POST", headers: { Cookie: "edgesonic_session=valid" }, body: form });
  assert.equal(forged.status, 400);
  const approved = await request("/authorize", { method: "POST", headers: { Cookie: `edgesonic_session=valid; ${cookie}` }, body: form });
  assert.equal(approved.status, 302, await approved.clone().text());
  const code = new URL(approved.headers.get("Location")!).searchParams.get("code");
  assert.ok(code);
  const tokenResponse = await request("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id, code, redirect_uri: "http://127.0.0.1:4321/callback", code_verifier: verifier, resource: "https://example.com/mcp" }) });
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const { access_token } = await tokenResponse.json() as { access_token: string };
  const headers = { Authorization: `Bearer ${access_token}` };
  const authorized = await request("/mcp", { method: "POST", headers });
  assert.equal(authorized.status, 200, await authorized.clone().text());
  assert.deepEqual((await authorized.json() as { scopes: string[] }).scopes.sort(), ["mcp:read", "mcp:write"]);
  assert.equal((await request("/mcp/upload/1", { method: "POST", headers })).status, 403);
  assert.equal((await request("/mcp", { method: "POST", headers: { Authorization: "Bearer subsonic-key" } })).status, 401);
  enabled = false;
  assert.equal((await request("/mcp", { method: "POST", headers })).status, 403);
  enabled = true;
  const grants = await request("/edgesonic/mcp/grants", { headers: { Cookie: "edgesonic_session=valid" } });
  assert.equal(grants.status, 200, await grants.clone().text());
  const list = await grants.json() as { items: Array<{ id: string }> };
  assert.equal(list.items.length, 1);
  const crossOrigin = await request("/edgesonic/mcp/grants/revoke", { method: "POST", headers: { Cookie: "edgesonic_session=valid", Origin: "https://attacker.example", "Content-Type": "application/json" }, body: JSON.stringify({ grantId: list.items[0].id }) });
  assert.equal(crossOrigin.status, 403);
  const revoke = await request("/edgesonic/mcp/grants/revoke", { method: "POST", headers: { Cookie: "edgesonic_session=valid", Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ grantId: list.items[0].id }) });
  assert.equal(revoke.status, 200, await revoke.clone().text());
  assert.equal((await request("/mcp", { method: "POST", headers })).status, 401);
});
