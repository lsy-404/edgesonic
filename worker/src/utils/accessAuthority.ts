// The identity center admits an account and records its level in users.level;
// permissions stay with the local level matrix.
const SERVICE_IDENTITIES = ["user", "admin"] as const;

export type AccessServiceIdentity = (typeof SERVICE_IDENTITIES)[number];
export type AccessAuthorization = {
  allowed: true;
  expiresAt: number | null;
  serviceIdentity: AccessServiceIdentity;
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
    || !(SERVICE_IDENTITIES as readonly string[]).includes(result.serviceIdentity)) {
    throw new ServiceAccessError("service_access_denied");
  }
  const configured = result.serviceConfig;
  if (configured !== undefined && configured !== null
    && (typeof configured !== "object" || Array.isArray(configured) || Object.keys(configured).length > 0)) {
    throw new ServiceAccessError("invalid_service_config");
  }
  return {
    allowed: true,
    expiresAt: result.expiresAt,
    serviceIdentity: result.serviceIdentity as AccessServiceIdentity,
  };
}
