import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import type { CustomFetch } from "openid-client";
import { beginOidcAuthorization, OIDC_TRANSACTION_COOKIE } from "../../worker/src/utils/oidc";

const ISSUER = "https://identity.example";
const CLIENT_ID = "edgesonic-advanced-client";
const CLIENT_SECRET = "advanced-client-secret";

function environment() {
  return {
    SSO_MODE: "optional",
    SSO_ISSUER: ISSUER,
    SSO_CLIENT_ID: CLIENT_ID,
    SSO_CLIENT_SECRET: CLIENT_SECRET,
    SSO_PROVIDER_NAME: "Identity",
    SSO_USE_PAR: "1",
    SSO_USE_JARM: "1",
    SSO_USE_DPOP: "1",
    DEV_TOKEN_SECRET: "advanced-edge-token-secret",
    INSTANCE_ID: "advanced-test",
  } as any;
}

async function main() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jarPrivateJwk = { ...(privateKey.export({ format: "jwk" }) as JsonWebKey), alg: "RS256", kid: "edge-jar-key" };
  const env = { ...environment(), SSO_JAR_PRIVATE_JWK: JSON.stringify(jarPrivateJwk) };
  let pushed: URLSearchParams | null = null;
  let dpopOnPar = false;
  const fetcher: CustomFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        response_modes_supported: ["query", "jwt"],
        request_object_signing_alg_values_supported: ["RS256"],
        pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
        dpop_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/oauth/par") {
      dpopOnPar = !!new Headers(init?.headers).get("DPoP");
      pushed = new URLSearchParams(String(init?.body || ""));
      return new Response(JSON.stringify({ request_uri: "urn:ietf:params:oauth:request-uri:edge-test", expires_in: 90 }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected provider request ${url}`);
  };

  const response = await beginOidcAuthorization(env, "https://music.example/login", fetcher);
  const location = new URL(response.authorizationUrl);
  assert.equal(location.searchParams.get("request_uri"), "urn:ietf:params:oauth:request-uri:edge-test");
  assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
  assert.ok(pushed?.get("request"), "PAR request must carry a signed JAR object");
  assert.equal(decodeJwt(pushed?.get("request") || "").response_mode, "jwt");
  assert.ok(decodeJwt(pushed?.get("request") || "").dpop_jkt, "authorization request must bind the DPoP key");
  assert.equal(dpopOnPar, true);
  assert.match(response.transactionCookie, new RegExp(`^${OIDC_TRANSACTION_COOKIE}=`));
  console.log("EdgeSonic PAR, JAR, JARM, and DPoP start checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
