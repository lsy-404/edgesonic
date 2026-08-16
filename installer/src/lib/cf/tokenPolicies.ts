import { callCfJson } from "../relay";

// These groups cover every installer write and the optional post-deploy API
// calls that use CF_API_TOKEN. Cloudflare policy inspection is non-mutating.
export const TOKEN_PERMISSION_GROUPS = {
  apiTokens: ["Account API Tokens Read", "Account API Tokens"],
  scripts: ["Workers Scripts Write", "Workers Scripts Edit", "Workers Scripts"],
  d1: ["D1 Write", "D1 Edit", "D1"],
  r2: ["Workers R2 Storage Write", "Workers R2 Storage Edit", "Workers R2 Storage"],
  ci: ["Workers CI Write", "Workers CI Edit", "Workers CI"],
  containers: ["Workers Containers Write", "Workers Containers Edit", "Workers Containers"],
  observability: ["Workers Observability Write", "Workers Observability Edit", "Workers Observability"],
  accountAnalytics: ["Account Analytics Read", "Account Analytics"],
  accountSettings: ["Account Settings Read", "Account Settings"],
  zoneRead: ["Zone Read", "Zone"],
  zoneSettings: ["Zone Settings Read", "Zone Settings"],
} as const;

interface TokenDetails {
  policies?: Array<{ effect?: string; permission_groups?: Array<{ name?: string }> }>;
}

export async function readTokenPermissionGroups(token: string, accountId: string, tokenId: string): Promise<Set<string>> {
  const details = await callCfJson<TokenDetails>(token, `/accounts/${accountId}/tokens/${tokenId}`, undefined, "Account API Tokens Read");
  return new Set(
    (details.policies || [])
      .filter((policy) => policy.effect === "allow")
      .flatMap((policy) => policy.permission_groups || [])
      .map((group) => group.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

export function hasTokenPermission(groups: Set<string>, key: keyof typeof TOKEN_PERMISSION_GROUPS): boolean {
  return TOKEN_PERMISSION_GROUPS[key].some((name) => groups.has(name));
}
