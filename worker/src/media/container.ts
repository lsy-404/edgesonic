// SPDX-License-Identifier: AGPL-3.0-or-later
import { Container } from "@cloudflare/containers";

export class MediaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2h";
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
    if (!new URL(request.url).pathname.startsWith("/media/")) return new Response(null, { status: 404 });
    const headers = new Headers(request.headers);
    headers.set("X-EdgeSonic-Container-Key", this.serviceKey);
    return this.containerFetch(new Request(request, { headers }));
  }
}
