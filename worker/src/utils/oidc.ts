// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildAuthorizationUrlWithJAR,
  buildAuthorizationUrlWithPAR,
  buildEndSessionUrl,
  calculatePKCECodeChallenge,
  ClientSecretBasic,
  ClientSecretPost,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  fetchUserInfo,
  getDPoPHandle,
  initiateDeviceAuthorization,
  randomDPoPKeyPair,
  refreshTokenGrant,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  useJwtResponseMode,
  type CustomFetch,
  type IDToken,
  type UserInfoResponse,
} from "openid-client";
import { CompactSign, calculateJwkThumbprint, importJWK } from "jose";
import { SESSION_TTL_SEC } from "../auth";
import type { User } from "../types/entities";
import { clampTtlToActivation, resolveActivation } from "./activation";
import { ensureSsoSchema } from "./schema_patch";
import { resolveSsoPolicy, type SsoEnvironment, type SsoPolicy } from "./ssoPolicy";

export const OIDC_TRANSACTION_COOKIE = "edgesonic_oidc_transaction";
export const OIDC_TRANSACTION_TTL_SEC = 10 * 60;

const TRANSACTION_VERSION = 2;
const COOKIE_AAD = new TextEncoder().encode("edgesonic-oidc-transaction-v2");
const SECRET_AAD_PREFIX = "edgesonic-oidc-secret-v1:";
const OIDC_TOKEN_MAX_BYTES = 64 * 1024;
export const OIDC_DEVICE_COOKIE = "edgesonic_oidc_device";

interface OidcTransaction {
  version: typeof TRANSACTION_VERSION;
  state: string;
  nonce: string;
  codeVerifier: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
  usePar: boolean;
  useJarm: boolean;
  dpopPrivateJwk?: JsonWebKey;
  dpopPublicJwk?: JsonWebKey;
  dpopJkt?: string;
}

interface StoredUserRow {
  username: string;
  master_password: string;
  level: number;
  enabled: number;
  activation_status?: string | null;
  activated_until?: number | null;
  created_at: number;
  updated_at: number;
}

export interface OidcLoginResult {
  username: string;
  level: number;
  sessionToken: string;
  expiresAt: number;
  activation: {
    enabled: boolean;
    status: string;
    until: number | null;
    active: boolean;
  };
}

export interface OidcAuthorizationStart {
  authorizationUrl: string;
  transactionCookie: string;
}

export interface OidcDeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  transactionCookie: string;
}

export interface OidcDeviceAuthorizationPoll {
  status: "pending" | "approved" | "denied" | "expired";
  tokenResponse?: Record<string, unknown>;
  retryAfter?: number;
}

export type OidcEnv = Env & SsoEnvironment;

export class OidcFlowError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "OidcFlowError";
  }
}

const runtimeFetch: CustomFetch = (url, options) => fetch(url, options);

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new OidcFlowError("invalid_transaction");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new OidcFlowError("invalid_transaction");
  }
}

function parseCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const equal = part.indexOf("=");
    if (equal < 0 || part.slice(0, equal).trim() !== name) continue;
    return part.slice(equal + 1).trim() || null;
  }
  return null;
}

function transactionCookieHeader(value: string, requestUrl: string, maxAge: number): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return [
    `${OIDC_TRANSACTION_COOKIE}=${value}`,
    "Path=/edgesonic/auth/sso",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ") + secure;
}

function deviceCookieHeader(value: string, requestUrl: string, maxAge: number): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${OIDC_DEVICE_COOKIE}=${value}; Path=/edgesonic/auth/sso/device; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearOidcTransactionCookie(requestUrl: string): string {
  return transactionCookieHeader("", requestUrl, 0);
}

export function clearOidcDeviceCookie(requestUrl: string): string {
  return deviceCookieHeader("", requestUrl, 0);
}

async function transactionKey(policy: SsoPolicy): Promise<CryptoKey> {
  if (!policy.clientSecret || !policy.issuer || !policy.clientId) throw new OidcFlowError("configuration_error");
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(policy.clientSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(policy.issuer),
      info: encoder.encode(`edgesonic-oidc-cookie-v1\0${policy.clientId}`),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function protectTransaction(policy: SsoPolicy, transaction: OidcTransaction): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(transaction));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: COOKIE_AAD },
    await transactionKey(policy),
    plaintext,
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function protectSecret(policy: SsoPolicy, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${SECRET_AAD_PREFIX}${policy.clientId}`) },
    await transactionKey(policy),
    new TextEncoder().encode(value),
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function unprotectSecret(policy: SsoPolicy, value: string): Promise<string> {
  const [ivPart, ciphertextPart] = value.split(".");
  if (!ivPart || !ciphertextPart) throw new OidcFlowError("invalid_secret");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivPart), additionalData: new TextEncoder().encode(`${SECRET_AAD_PREFIX}${policy.clientId}`) },
      await transactionKey(policy),
      base64UrlToBytes(ciphertextPart),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new OidcFlowError("invalid_secret");
  }
}

async function importJwkForUse(jwk: JsonWebKey, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (!jwk || typeof jwk !== "object" || typeof jwk.kty !== "string") throw new OidcFlowError("configuration_error");
  if (jwk.kty === "RSA") {
    const algorithm = jwk.alg === "PS256" ? { name: "RSA-PSS", hash: "SHA-256" } : jwk.alg === undefined || jwk.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : null;
    if (!algorithm) throw new OidcFlowError("configuration_error");
    return crypto.subtle.importKey("jwk", jwk, algorithm, false, [usage]);
  }
  if (jwk.kty === "EC" && jwk.crv === "P-256") {
    return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [usage]);
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    return crypto.subtle.importKey("jwk", jwk, "Ed25519", false, [usage]);
  }
  throw new OidcFlowError("configuration_error");
}

async function createDpopMaterial(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey; jkt: string }> {
  const keyPair = await randomDPoPKeyPair("ES256", { extractable: true });
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey) as JsonWebKey;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey) as JsonWebKey;
  return { privateJwk, publicJwk, jkt: await calculateJwkThumbprint(publicJwk as never, "sha256") };
}

async function createDpopProof(privateJwk: JsonWebKey, publicJwk: JsonWebKey, method: string, htu: string): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify({ htm: method, htu, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() })))
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk as never })
    .sign(await importJWK(privateJwk as never, "ES256"));
}

async function dpopHandleFromTransaction(transaction: OidcTransaction, config: Awaited<ReturnType<typeof oidcConfiguration>>) {
  if (!transaction.dpopPrivateJwk || !transaction.dpopPublicJwk) return undefined;
  const keyPair = {
    privateKey: await importJwkForUse(transaction.dpopPrivateJwk, "sign"),
    publicKey: await importJwkForUse(transaction.dpopPublicJwk, "verify"),
  };
  return getDPoPHandle(config, keyPair);
}

function isTransaction(value: unknown): value is OidcTransaction {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OidcTransaction>;
  const hasPrivate = Boolean(item.dpopPrivateJwk);
  const hasPublic = Boolean(item.dpopPublicJwk);
  return item.version === TRANSACTION_VERSION
    && typeof item.state === "string" && item.state.length >= 32 && item.state.length <= 256
    && typeof item.nonce === "string" && item.nonce.length >= 32 && item.nonce.length <= 256
    && typeof item.codeVerifier === "string" && item.codeVerifier.length >= 43 && item.codeVerifier.length <= 128
    && typeof item.issuer === "string" && item.issuer.length <= 2048
    && typeof item.clientId === "string" && item.clientId.length <= 512
    && typeof item.redirectUri === "string" && item.redirectUri.length <= 2048
    && typeof item.usePar === "boolean"
    && typeof item.useJarm === "boolean"
    && (!item.dpopPrivateJwk || typeof item.dpopPrivateJwk === "object")
    && (!item.dpopPublicJwk || typeof item.dpopPublicJwk === "object")
    && hasPrivate === hasPublic
    && (hasPrivate
      ? typeof item.dpopJkt === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(item.dpopJkt)
      : !item.dpopJkt)
    && Number.isInteger(item.expiresAt);
}

async function unprotectTransaction(policy: SsoPolicy, value: string): Promise<OidcTransaction> {
  const parts = value.split(".");
  if (parts.length !== 2) throw new OidcFlowError("invalid_transaction");
  const iv = base64UrlToBytes(parts[0]);
  if (iv.byteLength !== 12) throw new OidcFlowError("invalid_transaction");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: COOKIE_AAD },
      await transactionKey(policy),
      base64UrlToBytes(parts[1]),
    );
    const transaction = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!isTransaction(transaction)) throw new OidcFlowError("invalid_transaction");
    return transaction;
  } catch (error) {
    if (error instanceof OidcFlowError) throw error;
    throw new OidcFlowError("invalid_transaction");
  }
}

function requireConfiguredSso(env: SsoEnvironment, requestUrl: string): SsoPolicy {
  const policy = resolveSsoPolicy(env, requestUrl);
  if (policy.mode === "disabled") throw new OidcFlowError("sso_disabled");
  if (!policy.configured || policy.error || !policy.issuer || !policy.clientId || !policy.clientSecret || !policy.callbackUrl) {
    throw new OidcFlowError("configuration_error");
  }
  return policy;
}

async function oidcConfiguration(policy: SsoPolicy, fetcher: CustomFetch, useJarm = false) {
  const options = {
    [customFetch]: fetcher,
    execute: useJarm ? [enableNonRepudiationChecks, useJwtResponseMode] : [enableNonRepudiationChecks],
  };
  let config = await discovery(
    new URL(policy.issuer as string),
    policy.clientId as string,
    policy.clientSecret as string,
    ClientSecretBasic(policy.clientSecret as string),
    options,
  );
  const methods = config.serverMetadata().token_endpoint_auth_methods_supported;
  if (Array.isArray(methods) && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
    config = await discovery(
      new URL(policy.issuer as string),
      policy.clientId as string,
      policy.clientSecret as string,
      ClientSecretPost(policy.clientSecret as string),
      options,
    );
  }
  config.timeout = 10;
  return config;
}

function readJwkSecret(raw: string | undefined): JsonWebKey | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(raw) as JsonWebKey;
    return value && typeof value === "object" ? value : null;
  } catch {
    throw new OidcFlowError("configuration_error");
  }
}

function requestedScopes(metadata: Readonly<Record<string, unknown>>): string {
  const supported = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported as string[] : undefined;
  return ["openid", "profile", "email", "offline_access"]
    .filter((scope) => !supported || supported.includes(scope))
    .join(" ");
}

export async function beginOidcAuthorization(
  env: SsoEnvironment,
  requestUrl: string,
  fetcher: CustomFetch = runtimeFetch,
): Promise<OidcAuthorizationStart> {
  const policy = requireConfiguredSso(env, requestUrl);
  const config = await oidcConfiguration(policy, fetcher);
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const metadata = config.serverMetadata();
  const usePar = env.SSO_USE_PAR !== "0" && typeof metadata.pushed_authorization_request_endpoint === "string";
  const useJarm = env.SSO_USE_JARM === "1" && Array.isArray(metadata.response_modes_supported) && metadata.response_modes_supported.includes("jwt");
  let dpopHandle: ReturnType<typeof getDPoPHandle> | undefined;
  let dpopPrivateJwk: JsonWebKey | undefined;
  let dpopPublicJwk: JsonWebKey | undefined;
  if (env.SSO_USE_DPOP === "1" && Array.isArray(metadata.dpop_signing_alg_values_supported) && metadata.dpop_signing_alg_values_supported.includes("ES256")) {
    const keyPair = await randomDPoPKeyPair("ES256", { extractable: true });
    dpopHandle = getDPoPHandle(config, keyPair);
    dpopPrivateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey) as JsonWebKey;
    dpopPublicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey) as JsonWebKey;
  }
  const dpopJkt = dpopHandle ? await dpopHandle.calculateThumbprint() : undefined;
  const transaction: OidcTransaction = {
    version: TRANSACTION_VERSION,
    state,
    nonce,
    codeVerifier,
    issuer: policy.issuer as string,
    clientId: policy.clientId as string,
    redirectUri: policy.callbackUrl as string,
    expiresAt: Math.floor(Date.now() / 1000) + OIDC_TRANSACTION_TTL_SEC,
    usePar,
    useJarm,
    dpopPrivateJwk,
    dpopPublicJwk,
    dpopJkt,
  };
  const parameters = {
    redirect_uri: transaction.redirectUri,
    response_type: "code",
    scope: requestedScopes(metadata),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...(dpopJkt ? { dpop_jkt: dpopJkt } : {}),
    ...(useJarm ? { response_mode: "jwt" } : {}),
  };
  const jarJwk = readJwkSecret(env.SSO_JAR_PRIVATE_JWK);
  let authorizationUrl = jarJwk
    ? await buildAuthorizationUrlWithJAR(config, parameters, await importJwkForUse(jarJwk, "sign"))
    : buildAuthorizationUrl(config, parameters);
  if (usePar) authorizationUrl = await buildAuthorizationUrlWithPAR(config, authorizationUrl.searchParams, dpopHandle ? { DPoP: dpopHandle } : undefined);
  return {
    authorizationUrl: authorizationUrl.href,
    transactionCookie: transactionCookieHeader(
      await protectTransaction(policy, transaction),
      requestUrl,
      OIDC_TRANSACTION_TTL_SEC,
    ),
  };
}

export async function beginOidcDeviceAuthorization(
  env: OidcEnv,
  requestUrl: string,
  fetcher: CustomFetch = runtimeFetch,
): Promise<OidcDeviceAuthorizationStart> {
  const policy = requireConfiguredSso(env, requestUrl);
  const config = await oidcConfiguration(policy, fetcher);
  const metadata = config.serverMetadata();
  if (typeof metadata.device_authorization_endpoint !== "string") throw new OidcFlowError("unsupported_device_authorization");
  const response = await initiateDeviceAuthorization(config, { scope: requestedScopes(metadata) });
  const expiresIn = Number(response.expires_in);
  const interval = Number(response.interval || 5);
  if (!response.device_code || !response.user_code || !response.verification_uri || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OidcFlowError("invalid_device_response");
  }
  const transaction = {
    version: TRANSACTION_VERSION,
    deviceCode: response.device_code,
    issuer: policy.issuer,
    clientId: policy.clientId,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    ...(env.SSO_USE_DPOP === "1" && Array.isArray(metadata.dpop_signing_alg_values_supported) && metadata.dpop_signing_alg_values_supported.includes("ES256")
      ? await (async () => {
        const material = await createDpopMaterial();
        return { dpopPrivateJwk: material.privateJwk, dpopPublicJwk: material.publicJwk, dpopJkt: material.jkt };
      })()
      : {}),
  };
  return {
    deviceCode: response.device_code,
    userCode: response.user_code,
    verificationUri: response.verification_uri,
    verificationUriComplete: response.verification_uri_complete,
    expiresIn,
    interval,
    transactionCookie: deviceCookieHeader(
      await protectSecret(policy, JSON.stringify(transaction)),
      requestUrl,
      expiresIn,
    ),
  };
}

export async function pollOidcDeviceAuthorization(
  env: SsoEnvironment,
  requestUrl: string,
  cookieHeader: string,
  fetcher: CustomFetch = runtimeFetch,
): Promise<OidcDeviceAuthorizationPoll> {
  const policy = requireConfiguredSso(env, requestUrl);
  const cookie = parseCookie(cookieHeader, OIDC_DEVICE_COOKIE);
  if (!cookie) throw new OidcFlowError("missing_device_transaction");
  const transaction = JSON.parse(await unprotectSecret(policy, cookie)) as { version?: number; deviceCode?: string; issuer?: string; clientId?: string; expiresAt?: number; dpopPrivateJwk?: JsonWebKey; dpopPublicJwk?: JsonWebKey; dpopJkt?: string };
  if (transaction.version !== TRANSACTION_VERSION || !transaction.deviceCode || transaction.issuer !== policy.issuer || transaction.clientId !== policy.clientId || !transaction.expiresAt) throw new OidcFlowError("invalid_device_transaction");
  if (transaction.dpopJkt && !/^[A-Za-z0-9_-]{43,128}$/.test(transaction.dpopJkt)) throw new OidcFlowError("invalid_device_transaction");
  if (transaction.expiresAt <= Math.floor(Date.now() / 1000)) return { status: "expired" };

  const config = await oidcConfiguration(policy, fetcher);
  const endpoint = config.serverMetadata().token_endpoint;
  if (typeof endpoint !== "string") throw new OidcFlowError("configuration_error");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: transaction.deviceCode,
  });
  const dpopHeader = transaction.dpopPrivateJwk && transaction.dpopPublicJwk
    ? await createDpopProof(transaction.dpopPrivateJwk, transaction.dpopPublicJwk, "POST", endpoint)
    : undefined;
  const methods = config.serverMetadata().token_endpoint_auth_methods_supported;
  const useClientSecretPost = Array.isArray(methods) && !methods.includes("client_secret_basic") && methods.includes("client_secret_post");
  if (useClientSecretPost) {
    body.set("client_id", policy.clientId as string);
    body.set("client_secret", policy.clientSecret as string);
  }
  const response = await fetcher(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(useClientSecretPost ? {} : { Authorization: `Basic ${btoa(`${encodeURIComponent(policy.clientId as string)}:${encodeURIComponent(policy.clientSecret as string)}`)}` }),
      ...(dpopHeader ? { DPoP: dpopHeader } : {}),
    },
    body,
  });
  const text = await response.text();
  if (text.length > OIDC_TOKEN_MAX_BYTES) throw new OidcFlowError("invalid_device_response");
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { throw new OidcFlowError("invalid_device_response"); }
  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : "device_error";
    if (error === "authorization_pending" || error === "slow_down") return { status: "pending", retryAfter: error === "slow_down" ? 10 : 5 };
    if (error === "access_denied") return { status: "denied" };
    if (error === "expired_token") return { status: "expired" };
    throw new OidcFlowError(error);
  }
  validateDpopTokenResponse(payload.token_type, payload.cnf, transaction.dpopJkt);
  return { status: "approved", tokenResponse: payload };
}

export async function buildOidcLogoutUrl(
  env: OidcEnv,
  requestUrl: string,
  cookieHeader: string,
  postLogoutRedirectUri: string,
  fetcher: CustomFetch = runtimeFetch,
): Promise<string | null> {
  const policy = resolveSsoPolicy(env, requestUrl);
  if (policy.mode === "disabled" || !policy.configured || policy.error || !policy.issuer || !policy.clientId || !policy.clientSecret) return null;
  const sessionToken = parseCookie(cookieHeader, "edgesonic_session");
  if (!sessionToken) return null;
  await ensureSsoSchema(env);
  const row = await env.DB.prepare("SELECT sso_id_token FROM sessions WHERE token = ? AND username IS NOT NULL AND auth_source = 'sso'").bind(sessionToken).first<{ sso_id_token: string | null }>();
  if (!row?.sso_id_token) return null;
  const idToken = await unprotectSecret(policy, row.sso_id_token);
  const config = await oidcConfiguration(policy, fetcher);
  const metadata = config.serverMetadata();
  if (typeof metadata.end_session_endpoint !== "string") return null;
  return buildEndSessionUrl(config, { id_token_hint: idToken, post_logout_redirect_uri: postLogoutRedirectUri }).href;
}

export async function refreshOidcSession(
  env: OidcEnv,
  requestUrl: string,
  cookieHeader: string,
  fetcher: CustomFetch = runtimeFetch,
): Promise<OidcLoginResult> {
  const policy = requireConfiguredSso(env, requestUrl);
  const sessionToken = parseCookie(cookieHeader, "edgesonic_session");
  if (!sessionToken) throw new OidcFlowError("missing_session");
  await ensureSsoSchema(env);
  const row = await env.DB.prepare(
    `SELECT s.id, s.username, s.sso_refresh_token, s.sso_dpop_key, u.master_password,
            u.level, u.enabled, u.activation_status, u.activated_until, u.created_at, u.updated_at
       FROM sessions s JOIN users u ON u.username = s.username
      WHERE s.token = ? AND s.auth_source = 'sso' AND s.expires_at > ?`,
  ).bind(sessionToken, Math.floor(Date.now() / 1000)).first<StoredUserRow & { id: string; sso_refresh_token: string | null; sso_dpop_key: string | null }>();
  if (!row?.sso_refresh_token) throw new OidcFlowError("no_refresh_token");
  const refreshToken = await unprotectSecret(policy, row.sso_refresh_token);
  const config = await oidcConfiguration(policy, fetcher);
  let dpopHandle: ReturnType<typeof getDPoPHandle> | undefined;
  if (row.sso_dpop_key) {
    try {
      const keys = JSON.parse(await unprotectSecret(policy, row.sso_dpop_key)) as { privateKey?: JsonWebKey; publicKey?: JsonWebKey };
      if (keys.privateKey && keys.publicKey) {
        dpopHandle = getDPoPHandle(config, {
          privateKey: await importJwkForUse(keys.privateKey, "sign"),
          publicKey: await importJwkForUse(keys.publicKey, "verify"),
        });
      } else throw new Error("missing DPoP key material");
    } catch {
      throw new OidcFlowError("invalid_secret");
    }
  }
  const tokens = await refreshTokenGrant(config, refreshToken, undefined, dpopHandle ? { DPoP: dpopHandle } : undefined);
  validateDpopTokenResponse(tokens.token_type, tokens.cnf, dpopHandle ? await dpopHandle.calculateThumbprint() : undefined);
  const user = toUser(row);
  if (!user.enabled || user.level < 1) throw new OidcFlowError("account_disabled");
  const activation = await resolveActivation(env, user);
  const ttlSec = clampTtlToActivation(activation, SESSION_TTL_SEC);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const nextRefresh = typeof tokens.refresh_token === "string" ? await protectSecret(policy, tokens.refresh_token) : row.sso_refresh_token;
  const nextIdToken = typeof tokens.id_token === "string" ? await protectSecret(policy, tokens.id_token) : null;
  await env.DB.prepare(
    `UPDATE sessions SET sso_refresh_token = ?, sso_id_token = COALESCE(?, sso_id_token),
       sso_token_expires_at = ?, sso_refresh_expires_at = ?, expires_at = ?
     WHERE id = ? AND token = ? AND auth_source = 'sso'`,
  ).bind(nextRefresh, nextIdToken, Math.floor(Date.now() / 1000) + Number(tokens.expires_in || 300), Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, expiresAt, row.id, sessionToken).run();
  return {
    username: user.username,
    level: user.level,
    sessionToken,
    expiresAt,
    activation: { enabled: activation.enabled, status: activation.status, until: activation.until, active: activation.active },
  };
}

function toUser(row: StoredUserRow): User {
  return {
    username: row.username,
    password: row.master_password,
    level: row.level,
    enabled: row.enabled,
    activation_status: row.activation_status,
    activated_until: row.activated_until,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findMappedUser(db: D1Database, issuer: string, subject: string): Promise<User | null> {
  const row = await db.prepare(
    `SELECT u.username, u.master_password, u.level, u.enabled,
            u.activation_status, u.activated_until, u.created_at, u.updated_at
       FROM oidc_identities i
       JOIN users u ON u.username = i.username
      WHERE i.issuer = ? AND i.subject = ?`,
  ).bind(issuer, subject).first<StoredUserRow>();
  return row ? toUser(row) : null;
}

async function resolveIdentity(
  env: OidcEnv,
  issuer: string,
  subject: string,
  _idToken: IDToken,
  _userInfo: UserInfoResponse,
): Promise<User> {
  await ensureSsoSchema(env);
  const existing = await findMappedUser(env.DB, issuer, subject);
  if (existing) {
    await env.DB.prepare(
      "UPDATE oidc_identities SET last_login_at = ? WHERE issuer = ? AND subject = ?",
    ).bind(Math.floor(Date.now() / 1000), issuer, subject).run();
    return existing;
  }
  throw new OidcFlowError("identity_not_mapped");
}

function callbackBase(url: URL): string {
  const base = new URL(url.href);
  base.search = "";
  base.hash = "";
  return base.href;
}

export function validateAuthorizationResponseState(callbackUrl: string, expectedState: string): void {
  const currentUrl = new URL(callbackUrl);
  if (currentUrl.searchParams.has("response")) return;
  const returnedState = currentUrl.searchParams.get("state");
  if (!returnedState || returnedState !== expectedState) throw new OidcFlowError("state_mismatch");
}

export async function completeOidcAuthorization(
  env: OidcEnv,
  callbackUrl: string,
  cookieHeader: string,
  userAgent: string,
  fetcher: CustomFetch = runtimeFetch,
): Promise<OidcLoginResult> {
  const policy = requireConfiguredSso(env, callbackUrl);
  const protectedCookie = parseCookie(cookieHeader, OIDC_TRANSACTION_COOKIE);
  if (!protectedCookie) throw new OidcFlowError("missing_transaction");
  const transaction = await unprotectTransaction(policy, protectedCookie);
  const currentUrl = new URL(callbackUrl);
  validateAuthorizationResponseState(callbackUrl, transaction.state);
  if (transaction.expiresAt <= Math.floor(Date.now() / 1000)) throw new OidcFlowError("expired_transaction");
  if (transaction.issuer !== policy.issuer || transaction.clientId !== policy.clientId
    || transaction.redirectUri !== policy.callbackUrl || callbackBase(currentUrl) !== transaction.redirectUri) {
    throw new OidcFlowError("transaction_context_mismatch");
  }

  const config = await oidcConfiguration(policy, fetcher, transaction.useJarm);
  const dpopHandle = await dpopHandleFromTransaction(transaction, config);
  const tokens = await authorizationCodeGrant(config, currentUrl, {
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.codeVerifier,
    idTokenExpected: true,
  }, undefined, dpopHandle ? { DPoP: dpopHandle } : undefined);
  validateDpopTokenResponse(tokens.token_type, tokens.cnf, transaction.dpopJkt);
  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== "string" || !claims.sub || claims.iss !== policy.issuer) {
    throw new OidcFlowError("invalid_id_token");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(policy.clientId) || typeof claims.exp !== "number"
    || claims.exp <= Math.floor(Date.now() / 1000) || claims.nonce !== transaction.nonce) {
    throw new OidcFlowError("invalid_id_token");
  }
  const userInfo = await fetchUserInfo(config, tokens.access_token, claims.sub, dpopHandle ? { DPoP: dpopHandle } : undefined);
  const user = await resolveIdentity(env, claims.iss, claims.sub, claims, userInfo);
  if (!user.enabled || user.level < 1) throw new OidcFlowError("account_disabled");

  const activation = await resolveActivation(env, user);
  const ttlSec = clampTtlToActivation(activation, SESSION_TTL_SEC);
  const sessionToken = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const refreshToken = typeof tokens.refresh_token === "string" ? await protectSecret(policy, tokens.refresh_token) : null;
  const idToken = typeof tokens.id_token === "string" ? await protectSecret(policy, tokens.id_token) : null;
  const dpopKey = transaction.dpopPrivateJwk && transaction.dpopPublicJwk
    ? await protectSecret(policy, JSON.stringify({ privateKey: transaction.dpopPrivateJwk, publicKey: transaction.dpopPublicJwk }))
    : null;
  const tokenExpiresAt = Math.floor(Date.now() / 1000) + (typeof tokens.expires_in === "number" ? tokens.expires_in : 300);
  const refreshExpiresAt = refreshToken ? Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 : null;
  await env.DB.prepare(
    `INSERT INTO sessions
      (id, username, token, auth_source, user_agent, sso_refresh_token, sso_id_token,
       sso_token_expires_at, sso_refresh_expires_at, sso_issuer, sso_client_id, sso_dpop_key,
       expires_at, created_at)
     VALUES (?, ?, ?, 'sso', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    user.username,
    sessionToken,
    userAgent.slice(0, 512),
    refreshToken,
    idToken,
    tokenExpiresAt,
    refreshExpiresAt,
    policy.issuer,
    policy.clientId,
    dpopKey,
    expiresAt,
    Math.floor(Date.now() / 1000),
  ).run();

  return {
    username: user.username,
    level: user.level,
    sessionToken,
    expiresAt,
    activation: {
      enabled: activation.enabled,
      status: activation.status,
      until: activation.until,
      active: activation.active,
    },
  };
}

function validateDpopTokenResponse(tokenType: unknown, confirmation: unknown, expectedJkt?: string): void {
  const normalized = typeof tokenType === "string" ? tokenType.toLowerCase() : "";
  if (!normalized || !["bearer", "dpop"].includes(normalized)) throw new OidcFlowError("invalid_token_response");
  const confirmedJkt = confirmation && typeof confirmation === "object" && !Array.isArray(confirmation)
    ? (confirmation as { jkt?: unknown }).jkt
    : undefined;
  if (expectedJkt && (normalized !== "dpop" || confirmedJkt !== expectedJkt)) throw new OidcFlowError("invalid_token_response");
  if (!expectedJkt && normalized === "dpop") throw new OidcFlowError("invalid_token_response");
}
