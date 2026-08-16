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

//
// This Worker serves the installer wizard's static build (via the ASSETS
// binding — Cloudflare tries the asset manifest before invoking this script,
// so only unmatched paths reach here) and the CORS relay it needs:
//   /cf/*             — allow-listed passthrough to api.cloudflare.com (cfProxy.ts)
//   POST /r2/verify-keys — signed HEAD against R2's S3 endpoint (r2Verify.ts)
// See CONTRACT.md for the full spec. Never log Authorization headers,
// request/response bodies, or the R2 key pair — this Worker's entire trust
// model depends on it being a dumb pipe nobody can extract tokens from.
//
// Same-origin means the wizard's own calls never need CORS at all, but the
// headers stay on: CONTRACT.md's allowlist is deliberately reachable
// cross-origin too (e.g. a separately-hosted fork of the frontend), gated by
// the ALLOWED_ORIGINS allowlist rather than assuming same-origin only.

import { Hono } from "hono";
import { handleCfProxy } from "./cfProxy";
import { applyCorsHeaders, preflightResponse } from "./cors";
import { handleVerifyR2Keys } from "./r2Verify";
import { handleGithubAsset } from "./githubAsset";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return preflightResponse(c);
  }
  await next();
});

app.all("/cf/*", handleCfProxy);
app.post("/r2/verify-keys", handleVerifyR2Keys);
app.get("/github/release-asset", handleGithubAsset);

// Reaching here means neither a static asset nor an API route matched —
// let the asset binding produce its own 404 page instead of a bare JSON body.
app.notFound((c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers({ "Content-Type": "application/json" });
  applyCorsHeaders(c, headers);
  return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
    status: 404,
    headers,
  });
});

export default app;
