import OAuthProvider, { AuthorizationError, type OAuthHelpers, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { lookupUser, SESSION_COOKIE } from "../auth";
import { authorizeServiceAccess } from "../utils/accessAuthority";
import { resolveActivation } from "../utils/activation";
import { hasPermission } from "../utils/permissions";
import { resolveSsoPolicy } from "../utils/ssoPolicy";
import { isDemoMode } from "../utils/demoMode";
import { withMcpPrincipal, type McpPrincipal } from "./context";

export { withMcpPrincipal } from "./context";
export type { McpPrincipal } from "./context";
export const MCP_SCOPES = ["mcp:read", "mcp:upload", "mcp:write", "mcp:delete"] as const;
type Dispatcher = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;
type McpDispatcher = (request: Request, env: Env, ctx: ExecutionContext, principal: McpPrincipal) => Promise<Response> | Response;
type GrantProps = { username: string; authSource: "local" | "sso"; issuer?: string; subject?: string };
type ProviderEnv = Env & { OAUTH_KV: KVNamespace; OAUTH_PROVIDER: OAuthHelpers };
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

async function session(request: Request, env: Env, ctx: ExecutionContext, app: Dispatcher): Promise<GrantProps | null> {
  const cookie = request.headers.get("Cookie") || "";
  const token = cookie.split(";").map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const response = await app(new Request(new URL("/edgesonic/auth/me", request.url), { headers: { Cookie: cookie } }), env, ctx);
  if (!response.ok) return null;
  const info = await response.json<{ ok: boolean; username: string; level: number; authSource: "local" | "sso"; activation: { active: boolean } }>();
  if (!info.ok || !info.activation.active || info.level === 0) return null;
  if (info.authSource !== "sso") return { username: info.username, authSource: "local" };
  const row = await env.DB.prepare(`SELECT s.sso_issuer AS issuer, i.subject AS subject FROM sessions s
    JOIN oidc_identities i ON i.issuer = s.sso_issuer AND i.username = s.username
    WHERE s.token = ? AND s.username = ? AND s.expires_at > ? LIMIT 1`)
    .bind(token, info.username, Math.floor(Date.now() / 1000)).first<{ issuer: string; subject: string }>();
  return row ? { username: info.username, authSource: "sso", ...row } : null;
}

async function livePrincipal(env: Env, url: string, props: GrantProps, scopes: string[]): Promise<McpPrincipal | null> {
  if (!props || typeof props.username !== "string" || !["local", "sso"].includes(props.authSource)) return null;
  const user = await lookupUser(env.DB, props.username);
  if (!user || !user.enabled || user.level === 0) return null;
  const policy = resolveSsoPolicy(env, url);
  if (policy.failClosed || (policy.mode === "required" && props.authSource !== "sso") || (policy.mode === "disabled" && props.authSource === "sso")) return null;
  let identity: { username: string } | { subject: string } = { username: user.username };
  if (props.authSource === "sso") {
    if (!props.issuer || !props.subject) return null;
    const mapping = await env.DB.prepare("SELECT subject FROM oidc_identities WHERE issuer = ? AND username = ? AND subject = ? LIMIT 1")
      .bind(props.issuer, user.username, props.subject).first();
    if (!mapping) return null;
    identity = { subject: props.subject };
  }
  const access = await authorizeServiceAccess(env.ACCESS, identity);
  if (policy.mode === "required" && !access) return null;
  if (access) user.accessGranted = true;
  else if (!(await resolveActivation(env, user)).active) return null;
  const effective = scopes.filter(s => (MCP_SCOPES as readonly string[]).includes(s));
  if (!(await hasPermission(env, user, "browse"))) return null;
  if (!(await hasPermission(env, user, "upload"))) { const i = effective.indexOf("mcp:upload"); if (i >= 0) effective.splice(i, 1); }
  if (isDemoMode(env) || !(await hasPermission(env, user, "delete"))) { const i = effective.indexOf("mcp:delete"); if (i >= 0) effective.splice(i, 1); }
  if (!effective.includes("mcp:read")) return null;
  return { user, scopes: effective };
}

function consentPage(details: ConsentDescription, handle: string): string {
  const scopes = [...new Set(["mcp:read", ...details.scope])].filter(s => (MCP_SCOPES as readonly string[]).includes(s));
  return `<!doctype html><meta charset="utf-8"><title>Authorize MCP</title><h1>Allow ${escape(details.clientName)}?</h1>
<p>${details.clientDomain ? `Published by ${escape(details.clientDomain)}.` : "This application's name is not verified."} Access will be sent to ${escape(details.redirectHost)}.</p>
${details.redirectIsLoopback ? "<p>This grants access to an application on your computer. Continue only if you started this request.</p>" : ""}
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
${scopes.map(s => `<label><input type="checkbox" name="scope" value="${escape(s)}"${s === "mcp:delete" ? "" : " checked"}> ${escape(s)}</label><br>`).join("")}
<button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></form>`;
}

export function createMcpAuthHandler(app: Dispatcher, mcp: McpDispatcher): Dispatcher {
  return async (request, env, ctx) => {
    const path = new URL(request.url).pathname;
    if (!(path === "/mcp" || path.startsWith("/mcp/") || path === "/authorize" || path === "/edgesonic/mcp/grants" || path === "/edgesonic/mcp/grants/revoke" || path === "/oauth/token" || path === "/oauth/register" || path === "/oauth/revoke" || path.startsWith("/.well-known/oauth-"))) return app(request, env, ctx);
    if (!env.MCP_OAUTH_KV) return new Response("MCP authorization is not configured", { status: 503 });
    const origin = new URL(request.url).origin;
    const provider = new OAuthProvider<ProviderEnv>({
      apiRoute: "/mcp", authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: [...MCP_SCOPES], requiredScopes: ["mcp:read"], resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      apiHandler: { async fetch(req, e, context) {
        const auth = context as typeof context & { props: GrantProps; auth: { scope: string[] } };
        try {
          const principal = await livePrincipal(e, req.url, auth.props, auth.auth.scope);
          if (!principal) return new Response("Access denied", { status: 403 });
          if (new URL(req.url).pathname.startsWith("/mcp/upload/") && !principal.scopes.includes("mcp:upload")) return new Response("Insufficient scope", { status: 403 });
          return mcp(req, withMcpPrincipal(e, principal), context, principal);
        } catch { return new Response("Authorization unavailable", { status: 503 }); }
      } },
      defaultHandler: { async fetch(req, e, context) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/edgesonic/mcp/grants" || pathname === "/edgesonic/mcp/grants/revoke") {
          const identity = await session(req, e, context, app);
          if (!identity) return new Response("Authentication required", { status: 401 });
          const userId = encodeURIComponent(identity.username);
          if (pathname === "/edgesonic/mcp/grants" && req.method === "GET") {
            const result = await e.OAUTH_PROVIDER.listUserGrants(userId);
            return Response.json(result, { headers: { "Cache-Control": "no-store" } });
          }
          if (pathname === "/edgesonic/mcp/grants/revoke" && req.method === "POST") {
            if (req.headers.get("Origin") !== new URL(req.url).origin || !req.headers.get("Content-Type")?.startsWith("application/json")) return new Response("Forbidden", { status: 403 });
            const body = await req.json<{ grantId?: unknown }>();
            if (typeof body.grantId !== "string" || !body.grantId) return new Response("Invalid grant", { status: 400 });
            await e.OAUTH_PROVIDER.revokeGrant(body.grantId, userId);
            return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
          }
          return new Response("Method not allowed", { status: 405 });
        }
        if (pathname !== "/authorize") return app(req, e, context);
        const identity = await session(req, e, context, app);
        if (!identity) return new Response("Sign in to EdgeSonic, then restart authorization.", { status: 401 });
        try {
          const oauth = e.OAUTH_PROVIDER;
          if (req.method === "GET") {
            const parsed = await oauth.parseAuthRequest(req);
            const details = await oauth.describeConsent(parsed);
            const transaction = await oauth.beginConsent(parsed);
            transaction.headers.set("Content-Type", "text/html; charset=utf-8");
            return new Response(consentPage(details, transaction.handle), { headers: transaction.headers });
          }
          if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const form = await req.formData();
          const handle = String(form.get("handle") || "");
          if (form.get("decision") !== "approve") { const denied = await oauth.denyConsent(req, handle); return new Response(null, { status: 302, headers: denied.headers }); }
          const selected = form.getAll("scope").map(String).filter(s => (MCP_SCOPES as readonly string[]).includes(s));
          const principal = await livePrincipal(e, req.url, identity, selected);
          if (!principal) return new Response("Access denied", { status: 403 });
          const approved = await oauth.approveConsent(req, handle, { scope: principal.scopes });
          const result = await oauth.completeAuthorization({ request: approved.request, userId: encodeURIComponent(identity.username), metadata: {}, scope: principal.scopes, props: identity });
          approved.headers.set("Location", result.redirectTo);
          return new Response(null, { status: 302, headers: approved.headers });
        } catch (error) {
          if (error instanceof AuthorizationError) return new Response("Invalid or expired authorization request", { status: 400 });
          return new Response("Authorization unavailable", { status: 503 });
        }
      } },
    });
    return provider.fetch(request, { ...env, OAUTH_KV: env.MCP_OAUTH_KV } as ProviderEnv, ctx);
  };
}
