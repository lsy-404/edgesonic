import assert from "node:assert/strict";
import test from "node:test";
import { authorizeServiceAccess } from "../../worker/src/utils/accessAuthority";
import { hasPermission } from "../../worker/src/utils/permissions";

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
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  serviceIdentity: "member",
  serviceConfig: {},
  ...overrides,
});

test("service profile grants only its typed permission set and config can narrow it", async () => {
  const access = await authorizeServiceAccess(connector(valid({
    serviceIdentity: "creator",
    serviceConfig: { permissions: { upload: false, edit_tags: true } },
  })), { subject: "sub-1" });
  assert.ok(access);
  assert.equal(access.permissions.stream, true);
  assert.equal(access.permissions.edit_tags, true);
  assert.equal(access.permissions.upload, false);
  assert.equal(access.permissions.manage_users, undefined);
  const unbounded = await authorizeServiceAccess(connector(valid({ expiresAt: null })), { subject: "sub-1" });
  assert.equal(unbounded?.expiresAt, null);
  const noConfig = await authorizeServiceAccess(connector(valid({ serviceConfig: null })), { subject: "sub-1" });
  assert.equal(noConfig?.permissions.upload, true);
});

test("profile config cannot expand permissions and rejects unknown keys", async () => {
  const access = await authorizeServiceAccess(connector(valid({
    serviceIdentity: "listener",
    serviceConfig: { permissions: { upload: true } },
  })), { username: "alice" });
  assert.equal(access?.permissions.upload, false);
  await assert.rejects(() => authorizeServiceAccess(connector(valid({
    serviceConfig: { permissions: { manage_users: true } },
  })), { username: "alice" }), /invalid_service_config/);
});

test("denied, expired, malformed and unavailable grants fail closed", async () => {
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ allowed: false })), { subject: "sub-1" }), /service_access_denied/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ expiresAt: 1 })), { subject: "sub-1" }), /service_access_denied/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid({ serviceIdentity: "__proto__" })), { subject: "sub-1" }), /service_access_denied/);
  await assert.rejects(() => authorizeServiceAccess(connector(valid(), 503), { username: "alice" }), /access_authority_unavailable/);
  assert.equal(await authorizeServiceAccess(undefined, { username: "alice" }), null);
});

test("Access permissions override local business matrix without assigning admin powers", async () => {
  const db = {
    prepare() {
      return { bind() { return this; }, async first() { return { enabled: 0 }; }, async all() { return { results: [] }; } };
    },
  } as unknown as D1Database;
  const env = { DB: db };
  const user = { level: 1, accessPermissions: { upload: true, share: false } } as Parameters<typeof hasPermission>[1];
  assert.equal(await hasPermission(env, user, "upload"), true);
  assert.equal(await hasPermission(env, user, "share"), false);
  assert.equal(await hasPermission(env, user, "manage_permissions"), false);
  const localAdmin = { level: 3, accessPermissions: { stream: false } } as Parameters<typeof hasPermission>[1];
  assert.equal(await hasPermission(env, localAdmin, "stream"), false);
  assert.equal(await hasPermission(env, localAdmin, "manage_users"), true);
  const guest = { level: 0, accessPermissions: { upload: true, stream: true } } as Parameters<typeof hasPermission>[1];
  assert.equal(await hasPermission(env, guest, "upload"), false);
  assert.equal(await hasPermission(env, guest, "stream"), true);
});
