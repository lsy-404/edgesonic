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

// Studio gateway operations, kept free of `cloudflare:workers` so tests can
// drive them directly. The subject is the ID system's `sub`, mapped to a user
// through the configured SSO issuer exactly like an SSO login; every relayed
// request then runs through the normal app, so EdgeSonic's own auth,
// permission and route checks decide what that user may do.

import { lookupUser } from "../auth";
import type { User } from "../types/entities";
import { resolveActivation } from "../utils/activation";
import { findIdentityUser } from "../utils/oidc";
import { getEffectivePermissions } from "../utils/permissions";
import { resolveSsoPolicy } from "../utils/ssoPolicy";
import { isStudioRelayRoute, withStudioRelay } from "./relay";

export type StudioDispatch = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

export interface StudioPermissions {
  username: string;
  level: number;
  permissions: Record<string, boolean>;
}

// Credentials and anti-loop markers a relayed request might carry. Dropping
// them leaves the relay identity as the only one the auth middleware sees.
const STRIPPED_HEADERS = ["Cookie", "Authorization", "X-EdgeSonic-Chain", "X-OpenSubsonic-Path"];
const STRIPPED_PARAMS = ["u", "p", "t", "s", "apiKey", "guestToken", "esChain"];

// Only the issuer matters for mapping; any https origin satisfies the policy.
function policyOrigin(env: Env): string {
  return `https://${env.CANONICAL_HOST || "localhost"}`;
}

function gatewayError(status: 401 | 403 | 502, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

// Same gate as an SSO login (enabled, level >= 1), plus an active account:
// the relay reaches no activation surface, so a frozen account gets nothing.
export async function resolveStudioUser(env: Env, subject: string): Promise<User | null> {
  if (typeof subject !== "string" || !subject) return null;
  const policy = resolveSsoPolicy(env, policyOrigin(env));
  if (!policy.configured || !policy.issuer) return null;
  const mapped = await findIdentityUser(env, policy.issuer, subject);
  // Full users row, the same shape a cookie session hands to handlers.
  const user = mapped ? await lookupUser(env.DB, mapped.username) : null;
  if (!user || !user.enabled || user.level < 1) return null;
  if (!(await resolveActivation(env, user)).active) return null;
  return user;
}

export async function studioPermissions(env: Env, subject: string): Promise<StudioPermissions | null> {
  const user = await resolveStudioUser(env, subject);
  if (!user) return null;
  return { username: user.username, level: user.level, permissions: await getEffectivePermissions(env, user) };
}

export async function relayStudioRequest(
  env: Env,
  ctx: ExecutionContext,
  subject: string,
  request: Request,
  dispatch: StudioDispatch,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isStudioRelayRoute(request.method, url.pathname)) return gatewayError(403, "operation_not_allowed");
  const user = await resolveStudioUser(env, subject);
  if (!user) return gatewayError(401, "identity_unavailable");

  // The caller's host is ignored: relayed requests run over https on the
  // canonical host when one is configured.
  for (const key of STRIPPED_PARAMS) url.searchParams.delete(key);
  url.protocol = "https:";
  if (env.CANONICAL_HOST) url.host = env.CANONICAL_HOST;
  const relayed = new Request(url, request);
  for (const name of STRIPPED_HEADERS) relayed.headers.delete(name);

  const response = await dispatch(relayed, withStudioRelay(env, { subject, user }), ctx);
  // A redirect would hand the caller a URL to fetch outside the relay (a
  // presigned object link, a canonical-host hop); 304 carries no Location.
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    return gatewayError(502, "relay_redirect_blocked");
  }
  const headers = new Headers(response.headers);
  headers.delete("Set-Cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
