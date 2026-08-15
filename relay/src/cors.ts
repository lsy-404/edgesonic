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

import type { Context } from "hono";

const ALLOWED_METHODS = "GET, POST, PUT, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type";

type RelayContext = Context<{ Bindings: Env }>;

function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// Exact match only — CONTRACT.md §3 explicitly forbids reflecting an
// arbitrary Origin header.
export function resolveAllowedOrigin(c: RelayContext): string | null {
  const origin = c.req.header("Origin");
  if (!origin) return null;
  const allowed = parseAllowedOrigins(c.env.ALLOWED_ORIGINS);
  return allowed.includes(origin) ? origin : null;
}

export function applyCorsHeaders(c: RelayContext, headers: Headers): void {
  const allowedOrigin = resolveAllowedOrigin(c);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.append("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
}

export function preflightResponse(c: RelayContext): Response {
  const headers = new Headers();
  applyCorsHeaders(c, headers);
  return new Response(null, { status: 204, headers });
}

export function jsonResponse(c: RelayContext, status: number, body: unknown): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  applyCorsHeaders(c, headers);
  return new Response(JSON.stringify(body), { status, headers });
}
