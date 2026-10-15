// SPDX-License-Identifier: AGPL-3.0-or-later
import { Container } from "@cloudflare/containers";
import { getFeatureString } from "../utils/features";

interface RuntimeUsage {
  cycleStart: number;
  elapsedMs: number;
  runningSince: number | null;
}

export class MediaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
  private serviceKey = "";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.serviceKey = await ctx.storage.get<string>("service-key") || crypto.randomUUID() + crypto.randomUUID();
      await ctx.storage.put("service-key", this.serviceKey);
      this.envVars = { SHARED_KEY: this.serviceKey, PORT: "8080" };
    });
  }

  private async runtimeUsage() {
    const hours = Number(await getFeatureString(this.env, "media_container_budget_hours", "0"));
    const configuredDay = Number(await getFeatureString(this.env, "media_container_billing_day", "1"));
    const day = Number.isInteger(configuredDay) && configuredDay >= 1 && configuredDay <= 28 ? configuredDay : 1;
    const now = Date.now();
    const date = new Date(now);
    const month = date.getUTCMonth() - (date.getUTCDate() < day ? 1 : 0);
    const cycleStart = Date.UTC(date.getUTCFullYear(), month, day);
    const nextCycle = Date.UTC(date.getUTCFullYear(), month + 1, day);
    const saved = await this.ctx.storage.get<RuntimeUsage>("runtime-usage");
    const elapsedMs = (saved?.cycleStart === cycleStart ? saved.elapsedMs : 0)
      + (saved?.runningSince != null ? Math.max(0, now - Math.max(saved.runningSince, cycleStart)) : 0);
    return { hours, now, cycleStart, nextCycle, elapsedMs };
  }

  override async onStart(): Promise<void> {
    const usage = await this.runtimeUsage();
    await this.ctx.storage.put<RuntimeUsage>("runtime-usage", {
      cycleStart: usage.cycleStart, elapsedMs: usage.elapsedMs, runningSince: usage.now,
    });
  }

  override async onStop(): Promise<void> {
    const usage = await this.runtimeUsage();
    await this.ctx.storage.put<RuntimeUsage>("runtime-usage", {
      cycleStart: usage.cycleStart, elapsedMs: usage.elapsedMs, runningSince: null,
    });
  }

  private async accountKey(): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const material = await crypto.subtle.importKey("raw", encoder.encode(this.serviceKey), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(this.ctx.id.toString()), info: encoder.encode("edgesonic/media-accounts/v1") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async encryptAccount(value: string, context: string): Promise<{ ciphertext: string; iv: string }> {
    if (value.length > 65_536 || context.length > 1024) throw new Error("Account record is too large");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, await this.accountKey(), new TextEncoder().encode(value));
    return { ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))), iv: btoa(String.fromCharCode(...iv)) };
  }

  async decryptAccount(record: { ciphertext: string; iv: string }, context: string): Promise<string> {
    const bytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(record.iv), additionalData: new TextEncoder().encode(context) }, await this.accountKey(), bytes(record.ciphertext));
    return new TextDecoder().decode(plaintext);
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/media/")) return new Response(null, { status: 404 });
    const existingSession = path.startsWith("/media/sessions/") && request.method !== "POST";
    if (existingSession && request.method === "DELETE" && !this.ctx.container?.running) return new Response(null, { status: 204 });
    if (!existingSession || !this.ctx.container?.running) {
      const usage = await this.runtimeUsage();
      if (usage.hours > 0 && usage.elapsedMs >= usage.hours * 3_600_000) {
        return Response.json({ error: "Media container runtime budget reached" }, {
          status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((usage.nextCycle - usage.now) / 1000))) },
        });
      }
    }
    const headers = new Headers(request.headers);
    headers.set("X-EdgeSonic-Container-Key", this.serviceKey);
    return this.containerFetch(new Request(request, { headers }));
  }
}
