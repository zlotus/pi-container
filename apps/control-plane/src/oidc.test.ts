import { calculatePKCECodeChallenge } from "openid-client";
import Fastify from "fastify";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTPayload,
} from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GenericOidcClient, OidcTransactionStore } from "./oidc.js";

const CLIENT_ID = "agent-runtime-test";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "https://portal.example.test/auth/oidc/callback";

interface TokenBehavior {
  issuer?: string;
  audience?: string;
  nonce?: string;
  expirationTime?: number;
  invalidToken?: boolean;
}

describe("Generic OIDC client", () => {
  const idp = Fastify({ logger: false });
  let issuer = "";
  let privateKey: CryptoKey;
  let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
  let behavior: TokenBehavior = {};
  let lastTokenRequest: URLSearchParams | null = null;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    publicJwk = await exportJWK(keys.publicKey);
    Object.assign(publicJwk, { alg: "RS256", kid: "test-key", use: "sig" });

    idp.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );

    idp.get("/.well-known/openid-configuration", async () => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    }));
    idp.get("/jwks", async () => ({ keys: [publicJwk] }));
    idp.post("/token", async (request, reply) => {
      lastTokenRequest = new URLSearchParams(request.body as string);
      if (behavior.invalidToken) {
        return {
          access_token: "transient-access-token",
          token_type: "Bearer",
          id_token: "not-a-valid-jwt",
        };
      }
      const now = Math.floor(Date.now() / 1_000);
      const payload: JWTPayload = {
        sub: "subject-a",
        nonce: behavior.nonce ?? "nonce-a",
        email: "same@example.test",
        name: "OIDC User A",
      };
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(behavior.issuer ?? issuer)
        .setAudience(behavior.audience ?? CLIENT_ID)
        .setIssuedAt(now)
        .setExpirationTime(behavior.expirationTime ?? now + 300)
        .sign(privateKey);
      return reply.send({
        access_token: "transient-access-token",
        token_type: "Bearer",
        id_token: token,
      });
    });

    await idp.listen({ host: "127.0.0.1", port: 0 });
    const address = idp.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("mock IdP did not bind a TCP port");
    }
    issuer = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    behavior = {};
    lastTokenRequest = null;
  });

  afterAll(async () => {
    await idp.close();
  });

  function createClient() {
    return new GenericOidcClient({
      issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowInsecureIssuer: true,
    });
  }

  function callbackUrl(state = "state-a") {
    return new URL(
      `https://untrusted-host.example/callback?code=code-a&state=${state}`,
    );
  }

  const transaction = {
    state: "state-a",
    nonce: "nonce-a",
    codeVerifier: "verifier-a-that-is-long-enough-for-the-test-flow",
  };

  it("builds Authorization Code + PKCE + state + nonce and validates a standard ID token", async () => {
    const client = createClient();
    const authorization = await client.createAuthorizationRequest(REDIRECT_URI);
    const expectedChallenge = await calculatePKCECodeChallenge(
      authorization.transaction.codeVerifier,
    );

    expect(authorization.url.searchParams.get("response_type")).toBe("code");
    expect(authorization.url.searchParams.get("scope")).toBe(
      "openid email profile",
    );
    expect(authorization.url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorization.url.searchParams.get("state")).toBe(
      authorization.transaction.state,
    );
    expect(authorization.url.searchParams.get("nonce")).toBe(
      authorization.transaction.nonce,
    );
    expect(authorization.url.searchParams.get("code_challenge")).toBe(
      expectedChallenge,
    );
    expect(authorization.url.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );

    behavior.nonce = authorization.transaction.nonce;
    const identity = await client.exchangeAuthorizationCode({
      callbackUrl: new URL(
        `https://attacker.example/callback?code=code-a&state=${authorization.transaction.state}`,
      ),
      redirectUri: REDIRECT_URI,
      transaction: authorization.transaction,
    });

    expect(identity).toEqual({
      subject: "subject-a",
      usernameSnapshot: null,
      emailSnapshot: "same@example.test",
      displayNameSnapshot: "OIDC User A",
    });
    expect(lastTokenRequest?.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(lastTokenRequest?.get("code_verifier")).toBe(
      authorization.transaction.codeVerifier,
    );
    expect(lastTokenRequest?.get("client_id")).toBe(CLIENT_ID);
    expect(lastTokenRequest?.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("rejects a state mismatch", async () => {
    await expect(
      createClient().exchangeAuthorizationCode({
        callbackUrl: callbackUrl("wrong-state"),
        redirectUri: REDIRECT_URI,
        transaction,
      }),
    ).rejects.toThrow();
    expect(lastTokenRequest).toBeNull();
  });

  it("rejects a nonce mismatch", async () => {
    behavior.nonce = "wrong-nonce";
    await expect(
      createClient().exchangeAuthorizationCode({
        callbackUrl: callbackUrl(),
        redirectUri: REDIRECT_URI,
        transaction,
      }),
    ).rejects.toThrow();
  });

  it("rejects issuer and audience mismatches", async () => {
    behavior.issuer = "https://different-issuer.example";
    await expect(
      createClient().exchangeAuthorizationCode({
        callbackUrl: callbackUrl(),
        redirectUri: REDIRECT_URI,
        transaction,
      }),
    ).rejects.toThrow();

    behavior = { audience: "different-client", nonce: "nonce-a" };
    await expect(
      createClient().exchangeAuthorizationCode({
        callbackUrl: callbackUrl(),
        redirectUri: REDIRECT_URI,
        transaction,
      }),
    ).rejects.toThrow();
  });

  it("rejects expired and invalid ID tokens", async () => {
    behavior.expirationTime = Math.floor(Date.now() / 1_000) - 60;
    await expect(
      createClient().exchangeAuthorizationCode({
        callbackUrl: callbackUrl(),
        redirectUri: REDIRECT_URI,
        transaction,
      }),
    ).rejects.toThrow();

    behavior = { invalidToken: true };
    await expect(
      createClient().exchangeAuthorizationCode({
        callbackUrl: callbackUrl(),
        redirectUri: REDIRECT_URI,
        transaction,
      }),
    ).rejects.toThrow();
  });
});

describe("OIDC transaction store", () => {
  it("stores only a hash-indexed, expiring, single-use transaction", () => {
    const store = new OidcTransactionStore(1_000, 2);
    const now = new Date("2026-09-20T00:00:00.000Z");
    const transaction = {
      state: "state",
      nonce: "nonce",
      codeVerifier: "verifier",
    };
    const handle = store.create(transaction, now);

    expect(store.consume(handle, now)).toEqual(transaction);
    expect(store.consume(handle, now)).toBeNull();

    const expiredHandle = store.create(transaction, now);
    expect(
      store.consume(expiredHandle, new Date(now.getTime() + 1_000)),
    ).toBeNull();
  });
});
