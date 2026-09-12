// SPDX-License-Identifier: AGPL-3.0-or-later

export const SSO_CALLBACK_PATH = "/edgesonic/auth/sso/callback";
export const SSO_MODES = ["disabled", "optional", "required"] as const;

export type SsoMode = (typeof SSO_MODES)[number];
export type SsoConfigurationError =
  | "invalid_mode"
  | "missing_configuration"
  | "invalid_issuer"
  | "invalid_redirect_uri";

export interface SsoEnvironment {
  SSO_MODE?: string;
  SSO_ISSUER?: string;
  SSO_CLIENT_ID?: string;
  SSO_CLIENT_SECRET?: string;
  SSO_PROVIDER_NAME?: string;
}

export interface SsoPolicy {
  mode: SsoMode;
  configured: boolean;
  providerName: string;
  issuer: string | null;
  clientId: string | null;
  clientSecret: string | null;
  callbackUrl: string | null;
  error: SsoConfigurationError | null;
  failClosed: boolean;
  localAuthenticationAllowed: boolean;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseIssuer(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function derivedCallbackUrl(requestUrl: string): URL | null {
  try {
    const request = new URL(requestUrl);
    if (request.protocol !== "https:" && !(request.protocol === "http:" && isLoopback(request.hostname))) {
      return null;
    }
    return new URL(SSO_CALLBACK_PATH, request.origin);
  } catch {
    return null;
  }
}

function policyWithError(mode: SsoMode, providerName: string, error: SsoConfigurationError): SsoPolicy {
  const failClosed = mode === "required" || error === "invalid_mode";
  return {
    mode,
    configured: false,
    providerName,
    issuer: null,
    clientId: null,
    clientSecret: null,
    callbackUrl: null,
    error,
    failClosed,
    localAuthenticationAllowed: !failClosed,
  };
}

export function resolveSsoPolicy(env: SsoEnvironment, requestUrl: string): SsoPolicy {
  const rawMode = env.SSO_MODE?.trim() || "disabled";
  const providerName = env.SSO_PROVIDER_NAME?.trim().slice(0, 80) || "SSO";
  if (!SSO_MODES.includes(rawMode as SsoMode)) {
    return policyWithError("disabled", providerName, "invalid_mode");
  }

  const mode = rawMode as SsoMode;
  if (mode === "disabled") {
    return {
      mode,
      configured: false,
      providerName,
      issuer: null,
      clientId: null,
      clientSecret: null,
      callbackUrl: null,
      error: null,
      failClosed: false,
      localAuthenticationAllowed: true,
    };
  }

  const issuerRaw = env.SSO_ISSUER?.trim() || "";
  const clientId = env.SSO_CLIENT_ID?.trim() || "";
  const clientSecret = env.SSO_CLIENT_SECRET ?? "";
  if (!issuerRaw || !clientId || !clientSecret) {
    return policyWithError(mode, providerName, "missing_configuration");
  }

  const issuer = parseIssuer(issuerRaw);
  if (!issuer) return policyWithError(mode, providerName, "invalid_issuer");
  const callbackUrl = derivedCallbackUrl(requestUrl);
  if (!callbackUrl) return policyWithError(mode, providerName, "invalid_redirect_uri");

  return {
    mode,
    configured: true,
    providerName,
    issuer: issuer.href.replace(/\/$/, ""),
    clientId,
    clientSecret,
    callbackUrl: callbackUrl.href,
    error: null,
    failClosed: false,
    localAuthenticationAllowed: mode !== "required",
  };
}
