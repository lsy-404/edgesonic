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
// Drives the worker/transcoder-image container via @cloudflare/sandbox.
// The container exposes:
//  GET /health
//   POST /transcode?args=<json-argv> (raw audio body in, raw audio out)
// We synthesise the argv via buildFfmpegArgs(profile) and forward the request
// through `sandbox.containerFetch(url, init, 8080)` so the request → ffmpeg
// → response streams the whole way.
//
// Jobs are spread over a small pool of sandbox IDs, each of which is its own
// Durable Object + container instance, so more than one ffmpeg can run at a
// time.

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { TranscodeEngine, TranscodeInput, TranscodeJobRow, TranscodeOutput, TranscodeProfile } from "./engine";
import { buildFfmpegArgs } from "./profiles";
import { getFeatureString } from "../utils/features";

// Must stay at or below `max_instances` for the Sandbox container in
// wrangler.toml: asking for more distinct sandboxes than that leaves the extra
// ones with nowhere to start.
const POOL_SIZE = 3;

// FNV-1a, folded onto a pool slot. Any stable key works — the only property
// that matters is that one source always maps to one slot, so a container
// stays warm for repeat plays of the same track.
function poolSlot(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % POOL_SIZE;
}

// Bindings provided by wrangler.toml. The Sandbox class is re-exported from
// src/index.ts; this is its DurableObjectNamespace binding. The unknown
// generic matches the binding declared in wrangler.toml — we never call the
// DO's own RPC methods directly, only containerFetch().
interface SandboxBindings {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Sandbox: DurableObjectNamespace<Sandbox<any>>;
}

export interface SandboxEngineOptions {
  // Prefix for the pool's sandbox IDs. Defaults to "edgesonic-transcoder".
  // May switch to per-user pools to throttle isolation.
  sandboxId?: string;
  // Port the container is listening on. Matches EXPOSE in the Dockerfile.
  port?: number;
}

export class SandboxTranscodeEngine implements TranscodeEngine {
  readonly name = "sandbox";

  // Sandboxes are shared within a slot so cold starts amortise across
  // requests, and spread across slots so concurrent jobs are not serialised
  // behind one container.
  private readonly sandboxId: string;
  private readonly port: number;

  constructor(
    private readonly env: Env & SandboxBindings,
    opts: SandboxEngineOptions = {},
  ) {
    this.sandboxId = opts.sandboxId ?? "edgesonic-transcoder";
    this.port = opts.port ?? 8080;
  }

  // A missing key lands on the same slot every time, which is the old
  // single-sandbox behaviour and keeps probes off the busy slots.
  private async getSandbox(jobKey?: string): Promise<Sandbox> {
    const configured = await getFeatureString(this.env, "sandbox_idle_timeout_seconds", "150");
    const sleepAfter = ["15", "150", "300"].includes(configured) ? Number(configured) : 150;
    const id = `${this.sandboxId}-${poolSlot(jobKey ?? "")}`;
    return getSandbox(this.env.Sandbox, id, { sleepAfter });
  }

  async transcode(input: TranscodeInput, profile: TranscodeProfile): Promise<TranscodeOutput> {
    const sb = await this.getSandbox(input.jobKey);

    const args = buildFfmpegArgs(profile);
    const argsParam = encodeURIComponent(JSON.stringify(args));
    // The host is meaningless because containerFetch routes via the DO;
    // we only care about path + query.
    const url = `http://sandbox/transcode?args=${argsParam}`;

    const body = input.body instanceof Uint8Array
      ? input.body
      // The Sandbox SDK forwards ReadableStream<Uint8Array> as-is. We must
      // not consume it here — it stays unread until the container reads it.
      : input.body;

    const init: RequestInit = {
      method: "POST",
      body: body as BodyInit,
      headers: {
        "Content-Type": input.contentType ?? "application/octet-stream",
      },
    };

    // containerFetch handles port forwarding into the running container.
    // It returns a streaming Response — perfect for piping to the Worker
    // response.
    const resp = await sb.containerFetch(url, init, this.port);

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "<no body>");
      throw new Error(`sandbox transcode failed: HTTP ${resp.status} ${detail.slice(0, 200)}`);
    }
    if (!resp.body) {
      throw new Error("sandbox transcode returned no body");
    }

    return {
      body: resp.body,
      contentType: profile.contentType,
    };
  }

  // Sandbox engine has no remote job tracking — status is whatever the
  // dispatcher persisted in transcode_jobs. Caller falls back to D1.
  async getStatus(_jobId: string): Promise<TranscodeJobRow | null> {
    return null;
  }

  // Cancel is fire-and-forget: closing the upstream request kills the
  // ffmpeg child (see app.js req.on("close")). No remote endpoint to call.
  async cancel(_jobId: string): Promise<void> {
    return;
  }

  // Probe the container's /health endpoint. Cold-start cost is unavoidable
  // on first invocation; subsequent calls return in single-digit ms.
  async healthCheck(): Promise<boolean> {
    try {
      const sb = await this.getSandbox();
      const resp = await sb.containerFetch("http://sandbox/health", { method: "GET" }, this.port);
      if (!resp.ok) return false;
      const txt = await resp.text();
      return txt.trim() === "ok";
    } catch {
      return false;
    }
  }
}
