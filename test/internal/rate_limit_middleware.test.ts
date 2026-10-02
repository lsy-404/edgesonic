// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import {
  apiRateLimitMiddleware,
  apiRateLimitBucket,
  authenticatedRateLimitKey,
  authenticationRateLimitKey,
  rateLimitDeviceId,
  rateLimitAllowed,
  type RateLimiter,
} from "../../worker/src/middleware/rate_limit";
import { webLoginRoutes } from "../../worker/src/endpoints/edgesonic/auth";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

class Limiter implements RateLimiter {
  keys: string[] = [];
  constructor(private readonly success: boolean) {}
  async limit({ key }: { key: string }) {
    this.keys.push(key);
    return { success: this.success };
  }
}

async function main() {
  console.log("rate limit middleware:");

  const request = new Request("https://example.test/edgesonic/auth/login", {
    headers: { "User-Agent": "EdgeSonic Test Browser" },
  });
  const secondDeviceRequest = new Request("https://example.test/edgesonic/auth/login", {
    headers: { "User-Agent": "EdgeSonic Other Browser" },
  });
  const firstPartyDeviceRequest = new Request("https://example.test/edgesonic/auth/login", {
    headers: { "X-EdgeSonic-Device": "first-party-device-0001", "User-Agent": "EdgeSonic Test Browser" },
  });
  const secondFirstPartyDeviceRequest = new Request("https://example.test/edgesonic/auth/login", {
    headers: { "X-EdgeSonic-Device": "first-party-device-0002", "User-Agent": "EdgeSonic Test Browser" },
  });
  const loginKey = await authenticationRateLimitKey(request, "login", "  Alice ");
  const registerKey = await authenticationRateLimitKey(request, "register", "Alice");
  assert(
    /^auth:login:alice:[a-f0-9]{24}$/.test(loginKey),
    "login key combines its route and normalized username with a short device digest",
  );
  assert(
    registerKey !== loginKey,
    "register has an independent route key",
  );
  assert(
    await authenticationRateLimitKey(secondDeviceRequest, "login", "Alice") !== loginKey,
    "third-party authentication fallback includes client IP and user agent",
  );
  const firstPartyKey = await authenticationRateLimitKey(firstPartyDeviceRequest, "login", "Alice");
  assert(firstPartyKey !== await authenticationRateLimitKey(secondFirstPartyDeviceRequest, "login", "Alice"), "first-party device IDs isolate login budgets");
  assert(!firstPartyKey.includes("first-party-device-0001"), "first-party device ID is hashed before reaching RLB");
  assert(!loginKey.includes("EdgeSonic Test Browser"), "anonymous authentication key does not expose client signals");

  const sessionDeviceId = await rateLimitDeviceId("session", "session-id-a");
  const apiKeyDeviceId = await rateLimitDeviceId("apikey", "api-key-secret-a");
  const firstApiKey = authenticatedRateLimitKey("Alice", sessionDeviceId, "subsonic-read");
  const secondApiKey = authenticatedRateLimitKey("Alice", apiKeyDeviceId, "subsonic-read");
  assert(firstApiKey !== secondApiKey, "authenticated user keys isolate distinct devices");
  assert(authenticatedRateLimitKey("Alice", sessionDeviceId, "subsonic-read") !== authenticatedRateLimitKey("Alice", sessionDeviceId, "subsonic-write"), "Subsonic reads and writes have independent keys for the same identity");
  assert(authenticatedRateLimitKey("Alice", sessionDeviceId, "management") !== authenticatedRateLimitKey("Alice", sessionDeviceId, "subsonic-read"), "management has an independent key for the same identity");
  assert(!secondApiKey.includes("api-key-secret-a"), "authenticated key does not expose API credentials");

  assert(apiRateLimitBucket("/rest/star") === "subsonic-write", "GET-capable annotation mutations use the write bucket");
  assert(apiRateLimitBucket("/rest/createPlaylist.view/") === "subsonic-write", ".view aliases and trailing slashes normalize to the write bucket");
  assert(apiRateLimitBucket("/rest/search3") === "subsonic-read", "POST-capable search remains in the read bucket");
  assert(apiRateLimitBucket("/rest/notRegistered.view") === "management", "unknown REST operations remain rate limited in management");
  assert(apiRateLimitBucket("/tag/write") === "management", "management API routes use the management bucket");

  const missingBindingAllowed = await rateLimitAllowed(undefined, "anything");
  assert(missingBindingAllowed, "missing optional binding keeps local and legacy deployments running");

  const denied = new Limiter(false);
  assert(!(await rateLimitAllowed(denied, loginKey)), "RateLimit success=false denies requests");
  assert(denied.keys[0] === loginKey, "RateLimit receives the supplied key");

  const publicDb = {
    prepare(query: string) {
      return {
        bind() { return this; },
        async first() {
          return query.includes("external_secrets") ? { value: "test-key" } : null;
        },
        async all() {
          if (query.includes("feature_strings")) return { results: [{ key: "resend_from_email", value: "noreply@example.test" }] };
          return { results: [{ key: "open_registration", value: 1 }, { key: "enable_activation", value: 0 }] };
        },
      };
    },
  };
  const publicAuthApp = new Hono<{ Bindings: any }>();
  publicAuthApp.route("/", webLoginRoutes);
  const blockedAuth = new Limiter(false);
  const loginResponse = await publicAuthApp.request("https://example.test/edgesonic/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "EdgeSonic Test Browser" },
    body: JSON.stringify({ username: "Alice", password: "password123" }),
  }, { DB: publicDb, AUTH_RATE_LIMITER: blockedAuth });
  assert(loginResponse.status === 429, "login is protected by the authentication limiter");
  const registerResponse = await publicAuthApp.request("https://example.test/edgesonic/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "EdgeSonic Test Browser" },
    body: JSON.stringify({ username: "Alice", email: "alice@example.test", password: "password123" }),
  }, { DB: publicDb, AUTH_RATE_LIMITER: blockedAuth });
  assert(registerResponse.status === 429, "registration is protected by the authentication limiter");
  assert(blockedAuth.keys[0] === loginKey, "login uses its route-specific authentication key");
  assert(blockedAuth.keys[1] === registerKey, "registration uses its route-specific authentication key");

  const app = new Hono<{ Bindings: { API_RATE_LIMITER?: RateLimiter }; Variables: { user: { username: string }; rateLimitDeviceId?: string } }>();
  app.use("/rest/*", async (c, next) => {
    c.set("user", { username: "alice" });
    c.set("rateLimitDeviceId", sessionDeviceId);
    await next();
  });
  app.use("/rest/*", apiRateLimitMiddleware);
  app.get("/rest/ping", (c) => c.json({ ok: true }));

  const apiDenied = new Limiter(false);
  const limited = await app.request("https://example.test/rest/ping", undefined, { API_RATE_LIMITER: apiDenied });
  assert(limited.status === 429, "authenticated API request is rejected when its limiter is exhausted");
  assert(limited.headers.get("Retry-After") === "60", "API rejection includes Retry-After");
  assert(apiDenied.keys[0] === firstApiKey, "authenticated API limiter uses the stable user and device key");

  const allowed = await app.request("https://example.test/rest/ping", undefined, {});
  assert(allowed.status === 200, "authenticated API request remains available without the optional binding");

  const counts = new Map<string, number>();
  const perBucketLimiter: RateLimiter = {
    async limit({ key }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= 1 };
    },
  };
  const isolatedApp = new Hono<{ Bindings: { API_RATE_LIMITER?: RateLimiter }; Variables: { user: { username: string }; rateLimitDeviceId?: string } }>();
  isolatedApp.use("/*", async (c, next) => {
    c.set("user", { username: "alice" });
    c.set("rateLimitDeviceId", sessionDeviceId);
    await next();
  });
  isolatedApp.use("/rest/*", apiRateLimitMiddleware);
  isolatedApp.use("/tag/*", apiRateLimitMiddleware);
  isolatedApp.get("/rest/star", (c) => c.text("ok"));
  isolatedApp.get("/rest/star.view", (c) => c.text("ok"));
  isolatedApp.get("/rest/search3", (c) => c.text("ok"));
  isolatedApp.post("/rest/search3", (c) => c.text("ok"));
  isolatedApp.get("/tag/write", (c) => c.text("ok"));
  const isolatedBindings = { API_RATE_LIMITER: perBucketLimiter };
  assert((await isolatedApp.request("https://example.test/tag/write", undefined, isolatedBindings)).status === 200, "management request can use its own quota");
  assert((await isolatedApp.request("https://example.test/tag/write", undefined, isolatedBindings)).status === 429, "same management bucket still enforces its limit");
  assert((await isolatedApp.request("https://example.test/rest/star", undefined, isolatedBindings)).status === 200, "management exhaustion does not block a Subsonic write");
  assert((await isolatedApp.request("https://example.test/rest/star", undefined, isolatedBindings)).status === 429, "same Subsonic write bucket still enforces its limit");
  assert((await isolatedApp.request("https://example.test/rest/star.view", undefined, isolatedBindings)).status === 429, "registered .view mutation alias consumes the same write quota");
  assert((await isolatedApp.request("https://example.test/rest/search3", { method: "POST" }, isolatedBindings)).status === 200, "write exhaustion does not block a POST Subsonic read");
  assert((await isolatedApp.request("https://example.test/rest/search3", undefined, isolatedBindings)).status === 429, "same Subsonic read bucket still enforces its limit");
  const otherDeviceApp = new Hono<{ Bindings: { API_RATE_LIMITER?: RateLimiter }; Variables: { user: { username: string }; rateLimitDeviceId?: string } }>();
  otherDeviceApp.use("/rest/*", async (c, next) => {
    c.set("user", { username: "alice" });
    c.set("rateLimitDeviceId", apiKeyDeviceId);
    await next();
  });
  otherDeviceApp.use("/rest/*", apiRateLimitMiddleware);
  otherDeviceApp.get("/rest/star", (c) => c.text("ok"));
  assert((await otherDeviceApp.request("https://example.test/rest/star", undefined, isolatedBindings)).status === 200, "the same username on a distinct device keeps a separate write quota");

  const noPrincipalApp = new Hono<{ Bindings: { API_RATE_LIMITER?: RateLimiter }; Variables: { user: { username: string }; rateLimitDeviceId?: string } }>();
  noPrincipalApp.use("/rest/*", async (c, next) => {
    c.set("user", { username: "alice" });
    await next();
  });
  noPrincipalApp.use("/rest/*", apiRateLimitMiddleware);
  noPrincipalApp.get("/rest/ping", (c) => c.json({ ok: true }));
  const noPrincipalResponse = await noPrincipalApp.request("https://example.test/rest/ping", undefined, { API_RATE_LIMITER: apiDenied });
  assert(noPrincipalResponse.status === 500, "API requests fail closed when the authentication device principal is unavailable");

  const publicApp = new Hono<{ Bindings: { API_RATE_LIMITER?: RateLimiter }; Variables: { user?: { username: string }; rateLimitDeviceId?: string } }>();
  publicApp.use("/edgesonic/*", apiRateLimitMiddleware);
  publicApp.get("/edgesonic/auth/loginConfig", (c) => c.json({ ok: true }));
  const publicResponse = await publicApp.request("https://example.test/edgesonic/auth/loginConfig", undefined, { API_RATE_LIMITER: apiDenied });
  assert(publicResponse.status === 200, "public EdgeSonic authentication routes bypass the global API limiter");

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
}

void main();
