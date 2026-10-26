import type { AccessPermission } from "../types/entities";
import { ACCESS_PERMISSIONS } from "./permissions";

const PROFILES = {
  listener: ["stream", "browse", "search"],
  member: ["stream", "browse", "search", "download", "upload", "share", "manage_playlists", "manage_podcasts", "manage_radio"],
  creator: ["stream", "browse", "search", "download", "upload", "share", "manage_playlists", "manage_podcasts", "manage_radio", "edit_tags", "edit_annotations"],
} as const satisfies Record<string, readonly AccessPermission[]>;

export type AccessServiceIdentity = keyof typeof PROFILES;
export type AccessAuthorization = {
  allowed: true;
  expiresAt: number | null;
  serviceIdentity: AccessServiceIdentity;
  permissions: Record<AccessPermission, boolean>;
};

export type AccessSubject = { subject: string } | { username: string };

export class ServiceAccessError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ServiceAccessError";
  }
}

export async function authorizeServiceAccess(
  binding: Fetcher | undefined,
  identity: AccessSubject,
): Promise<AccessAuthorization | null> {
  if (!binding) return null;
  const response = await binding.fetch("https://access.internal/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(identity),
  });
  if (!response.ok) throw new ServiceAccessError("access_authority_unavailable");
  const result = await response.json<Record<string, unknown>>();
  const now = Math.floor(Date.now() / 1000);
  if (result.allowed !== true
    || !(result.expiresAt === null || (typeof result.expiresAt === "number" && Number.isInteger(result.expiresAt) && result.expiresAt > now))
    || typeof result.serviceIdentity !== "string"
    || !Object.hasOwn(PROFILES, result.serviceIdentity)) {
    throw new ServiceAccessError("service_access_denied");
  }
  const profile: readonly AccessPermission[] = PROFILES[result.serviceIdentity as AccessServiceIdentity];
  const configured = result.serviceConfig;
  if (configured !== undefined && configured !== null && (typeof configured !== "object" || Array.isArray(configured))) {
    throw new ServiceAccessError("invalid_service_config");
  }
  if (configured && Object.keys(configured).some((key) => key !== "permissions")) {
    throw new ServiceAccessError("invalid_service_config");
  }
  const configuredPermissions = configured && "permissions" in configured
    ? (configured as { permissions?: unknown }).permissions
    : undefined;
  if (configuredPermissions !== undefined
    && (configuredPermissions === null || typeof configuredPermissions !== "object" || Array.isArray(configuredPermissions))) {
    throw new ServiceAccessError("invalid_service_config");
  }
  const overrides = (configuredPermissions || {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (!(ACCESS_PERMISSIONS as readonly string[]).includes(key) || typeof value !== "boolean") {
      throw new ServiceAccessError("invalid_service_config");
    }
  }
  const permissions = Object.fromEntries(ACCESS_PERMISSIONS.map((permission) => [
    permission,
    profile.includes(permission) && overrides[permission] !== false,
  ])) as Record<AccessPermission, boolean>;
  return {
    allowed: true,
    expiresAt: result.expiresAt,
    serviceIdentity: result.serviceIdentity as AccessServiceIdentity,
    permissions,
  };
}
