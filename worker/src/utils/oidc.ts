// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretBasic,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  fetchUserInfo,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type CustomFetch,
  type IDToken,
  type UserInfoResponse,
} from "openid-client";
import { hashWebPassword, SESSION_TTL_SEC } from "../auth";
import type { User } from "../types/entities";
import { clampTtlToActivation, resolveActivation } from "./activation";
import { getFeature } from "./features";
import { ensureActivationSchema, ensureSsoSchema } from "./schema_patch";
import { resolveSsoPolicy, type SsoEnvironment, type SsoPolicy } from "./ssoPolicy";

export const OIDC_TRANSACTION_COOKIE = "edgesonic_oidc_transaction";
export const OIDC_TRANSACTION_TTL_SEC = 10 * 60;

const TRANSACTION_VERSION = 1;
const COOKIE_AAD = new TextEncoder().encode("edgesonic-oidc-transaction-v1");

interface OidcTransaction {
  version: typeof TRANSACTION_VERSION;
  state: string;
  nonce: string;
  codeVerifier: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
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

export function clearOidcTransactionCookie(requestUrl: string): string {
  return transactionCookieHeader("", requestUrl, 0);
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

function isTransaction(value: unknown): value is OidcTransaction {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OidcTransaction>;
  return item.version === TRANSACTION_VERSION
    && typeof item.state === "string" && item.state.length >= 32 && item.state.length <= 256
    && typeof item.nonce === "string" && item.nonce.length >= 32 && item.nonce.length <= 256
    && typeof item.codeVerifier === "string" && item.codeVerifier.length >= 43 && item.codeVerifier.length <= 128
    && typeof item.issuer === "string" && item.issuer.length <= 2048
    && typeof item.clientId === "string" && item.clientId.length <= 512
    && typeof item.redirectUri === "string" && item.redirectUri.length <= 2048
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

async function oidcConfiguration(policy: SsoPolicy, fetcher: CustomFetch) {
  const config = await discovery(
    new URL(policy.issuer as string),
    policy.clientId as string,
    policy.clientSecret as string,
    ClientSecretBasic(policy.clientSecret as string),
    {
      [customFetch]: fetcher,
      execute: [enableNonRepudiationChecks],
    },
  );
  config.timeout = 10;
  return config;
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
  const transaction: OidcTransaction = {
    version: TRANSACTION_VERSION,
    state,
    nonce,
    codeVerifier,
    issuer: policy.issuer as string,
    clientId: policy.clientId as string,
    redirectUri: policy.callbackUrl as string,
    expiresAt: Math.floor(Date.now() / 1000) + OIDC_TRANSACTION_TTL_SEC,
  };
  const authorizationUrl = buildAuthorizationUrl(config, {
    redirect_uri: transaction.redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return {
    authorizationUrl: authorizationUrl.href,
    transactionCookie: transactionCookieHeader(
      await protectTransaction(policy, transaction),
      requestUrl,
      OIDC_TRANSACTION_TTL_SEC,
    ),
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

function profileName(idToken: IDToken, userInfo: UserInfoResponse): string | null {
  for (const value of [userInfo.preferred_username, userInfo.name, idToken.preferred_username, idToken.name]) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().slice(0, 64);
    if (normalized) return normalized;
  }
  return null;
}

async function resolveIdentity(
  env: OidcEnv,
  issuer: string,
  subject: string,
  idToken: IDToken,
  userInfo: UserInfoResponse,
): Promise<User> {
  await ensureSsoSchema(env);
  const existing = await findMappedUser(env.DB, issuer, subject);
  if (existing) {
    await env.DB.prepare(
      "UPDATE oidc_identities SET last_login_at = ? WHERE issuer = ? AND subject = ?",
    ).bind(Math.floor(Date.now() / 1000), issuer, subject).run();
    return existing;
  }

  await ensureActivationSchema(env);
  const now = Math.floor(Date.now() / 1000);
  const username = `sso_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const password = await hashWebPassword(bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))));
  const activationStatus = await getFeature(env, "enable_activation") ? "disabled" : "permanent";
  const nickname = profileName(idToken, userInfo);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
          (username, master_password, level, enabled, nickname, activation_status, created_at, updated_at)
         VALUES (?, ?, 1, 1, ?, ?, ?, ?)`,
      ).bind(username, password, nickname, activationStatus, now, now),
      env.DB.prepare(
        `INSERT INTO oidc_identities (issuer, subject, username, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(issuer, subject, username, now, now),
    ]);
  } catch (error) {
    const raced = await findMappedUser(env.DB, issuer, subject);
    if (raced) return raced;
    throw error;
  }

  return {
    username,
    password,
    level: 1,
    enabled: 1,
    activation_status: activationStatus,
    activated_until: null,
    created_at: now,
    updated_at: now,
  };
}

function callbackBase(url: URL): string {
  const base = new URL(url.href);
  base.search = "";
  base.hash = "";
  return base.href;
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
  const returnedState = currentUrl.searchParams.get("state");
  if (!returnedState || returnedState !== transaction.state) throw new OidcFlowError("state_mismatch");
  if (transaction.expiresAt <= Math.floor(Date.now() / 1000)) throw new OidcFlowError("expired_transaction");
  if (transaction.issuer !== policy.issuer || transaction.clientId !== policy.clientId
    || transaction.redirectUri !== policy.callbackUrl || callbackBase(currentUrl) !== transaction.redirectUri) {
    throw new OidcFlowError("transaction_context_mismatch");
  }

  const config = await oidcConfiguration(policy, fetcher);
  const tokens = await authorizationCodeGrant(config, currentUrl, {
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.codeVerifier,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== "string" || !claims.sub || claims.iss !== policy.issuer) {
    throw new OidcFlowError("invalid_id_token");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(policy.clientId) || typeof claims.exp !== "number"
    || claims.exp <= Math.floor(Date.now() / 1000) || claims.nonce !== transaction.nonce) {
    throw new OidcFlowError("invalid_id_token");
  }
  const userInfo = await fetchUserInfo(config, tokens.access_token, claims.sub);
  const user = await resolveIdentity(env, claims.iss, claims.sub, claims, userInfo);
  if (!user.enabled || user.level < 1) throw new OidcFlowError("account_disabled");

  const activation = await resolveActivation(env, user);
  const ttlSec = clampTtlToActivation(activation, SESSION_TTL_SEC);
  const sessionToken = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  await env.DB.prepare(
    `INSERT INTO sessions (id, username, token, auth_source, user_agent, expires_at, created_at)
     VALUES (?, ?, ?, 'sso', ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    user.username,
    sessionToken,
    userAgent.slice(0, 512),
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
