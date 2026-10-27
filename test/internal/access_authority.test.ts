import assert from "node:assert/strict";
import test from "node:test";
import { authorizeServiceAccess } from "../../worker/src/utils/accessAuthority";

function connector(reply: unknown, status = 200): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "https://access.internal/authorize");
      assert.equal(init?.method, "POST");
      return Response.json(reply, { status });
    },
  } as unknown as Fetcher;
}

const valid = (overrides: Record<string, unknown> = {}) => ({
  allowed: true,
  source: "assignment",
  roles: ["user"],
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  serviceIdentity: "user",
  serviceConfig: {},
  subject: "sub-1",
  ...overrides,
});

test("user and admin service identities are admitted with their grant expiry", async () => {
  const user = await authorizeServiceAccess(connector(valid()), { subject: "sub-1" });
  assert.equal(user?.serviceIdentity, "user");
  assert.ok(typeof user?.expiresAt === "number");
  const admin = await authorizeServiceAccess(connector(valid({
    source: "admin", roles: ["admin"], serviceIdentity: "admin", expiresAt: null,
  })), { username: "alice" });
  assert.equal(admin?.serviceIdentity, "admin");
  assert.equal(admin?.expiresAt, null);
  const noConfig = await authorizeServiceAccess(connector(valid({ serviceConfig: null })), { subject: "sub-1" });
  assert.equal(noConfig?.allowed, true);
});

test("service config cannot carry permissions or other settings", async () => {
  await assert.rejects(() => authorizeServiceAccess(connector(valid({
    serviceConfig: { permissions: { upload: true } },
  })), { username: "alice" }), /invalid_service_config/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ serviceConfig: [] })), { username: "alice" }), /invalid_service_config/);
});

test("denied, expired, malformed and unavailable grants fail closed", async () => {
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ allowed: false })), { subject: "sub-1" }), /service_access_denied/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ expiresAt: 1 })), { subject: "sub-1" }), /service_access_denied/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ serviceIdentity: "member" })), { subject: "sub-1" }), /service_access_denied/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ serviceIdentity: "__proto__" })), { subject: "sub-1" }), /service_access_denied/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ serviceIdentity: null })), { subject: "sub-1" }), /service_access_denied/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid(), 503), { username: "alice" }), /access_authority_unavailable/);
  assert.equal(await authorizeServiceAccess(undefined, { username: "alice" }), null);
});
