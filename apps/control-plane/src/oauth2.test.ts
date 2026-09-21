import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GenericOAuth2UserInfoClient,
  OAuth2TransactionStore,
} from "./oauth2.js";

const CLIENT_ID = "oauth2-client";
const CLIENT_SECRET = "oauth2-client-secret";
const REDIRECT_URI = "https://portal.example.test/auth/oauth2/callback";

describe("Generic OAuth2 UserInfo client", () => {
  const provider = Fastify({ logger: false });
  let origin = "";
  let userinfo: unknown;
  let userinfoStatus = 200;
  let tokenStatus = 200;
  let tokenRequest: URLSearchParams | null = null;
  let authorizationHeader: string | undefined;
  let userinfoAccessToken: string | undefined;

  beforeAll(async () => {
    provider.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
    provider.post("/token", async (request, reply) => {
      tokenRequest = new URLSearchParams(request.body as string);
      return reply.code(tokenStatus).send(
        tokenStatus === 200
          ? {
              access_token: "callback-only-access-token",
              token_type: "Bearer",
            }
          : { error: "invalid_grant" },
      );
    });
    provider.get("/userinfo", async (request, reply) => {
      authorizationHeader = request.headers.authorization;
      const query = request.query as { access_token?: string };
      userinfoAccessToken = query.access_token;
      return reply.code(userinfoStatus).send(userinfo);
    });
    await provider.listen({ host: "127.0.0.1", port: 0 });
    const address = provider.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("mock OAuth2 provider did not bind a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    userinfo = {
      attributes: {
        workcode: "weaver-001",
        email: "user@example.test",
        displayName: "Weaver User",
      },
    };
    userinfoStatus = 200;
    tokenStatus = 200;
    tokenRequest = null;
    authorizationHeader = undefined;
    userinfoAccessToken = undefined;
  });

  afterAll(async () => provider.close());

  function client(options?: {
    userinfoTokenMethod?: "bearer" | "query";
    subjectField?: string;
  }) {
    return new GenericOAuth2UserInfoClient({
      authorizationUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/token`,
      userinfoUrl: `${origin}/userinfo`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: "profile",
      subjectField: options?.subjectField ?? "attributes.workcode",
      usernameField: "attributes.workcode",
      emailField: "attributes.email",
      displayNameField: "attributes.displayName",
      userinfoTokenMethod: options?.userinfoTokenMethod ?? "bearer",
    });
  }

  it("uses Authorization Code + PKCE + state and maps nested UserInfo fields", async () => {
    const oauth2 = client();
    const authorization = await oauth2.createAuthorizationRequest(REDIRECT_URI);
    expect(authorization.url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorization.url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorization.url.searchParams.get("state")).toBe(
      authorization.transaction.state,
    );
    expect(authorization.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.url.searchParams.get("scope")).toBe("profile");

    const profile = await oauth2.exchangeAuthorizationCode({
      callbackUrl: new URL(
        `${REDIRECT_URI}?code=code-a&state=${authorization.transaction.state}`,
      ),
      redirectUri: REDIRECT_URI,
      transaction: authorization.transaction,
    });

    expect(profile).toEqual({
      subject: "weaver-001",
      usernameSnapshot: "weaver-001",
      emailSnapshot: "user@example.test",
      displayNameSnapshot: "Weaver User",
    });
    expect(tokenRequest?.get("client_secret")).toBe(CLIENT_SECRET);
    expect(tokenRequest?.get("code_verifier")).toBe(
      authorization.transaction.codeVerifier,
    );
    expect(authorizationHeader).toBe("Bearer callback-only-access-token");
    expect(userinfoAccessToken).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain("callback-only-access-token");
  });

  it("supports non-standard query token transport and bracket JSON paths", async () => {
    const oauth2 = client({
      userinfoTokenMethod: "query",
      subjectField: 'attributes["workcode"]',
    });
    const authorization = await oauth2.createAuthorizationRequest(REDIRECT_URI);
    const profile = await oauth2.exchangeAuthorizationCode({
      callbackUrl: new URL(
        `${REDIRECT_URI}?code=code-a&state=${authorization.transaction.state}`,
      ),
      redirectUri: REDIRECT_URI,
      transaction: authorization.transaction,
    });

    expect(profile.subject).toBe("weaver-001");
    expect(authorizationHeader).toBeUndefined();
    expect(userinfoAccessToken).toBe("callback-only-access-token");
    expect(JSON.stringify(profile)).not.toContain("callback-only-access-token");
  });

  it("rejects state mismatch before exchanging a code", async () => {
    await expect(
      client().exchangeAuthorizationCode({
        callbackUrl: new URL(`${REDIRECT_URI}?code=code-a&state=wrong`),
        redirectUri: REDIRECT_URI,
        transaction: { state: "expected", codeVerifier: "verifier" },
      }),
    ).rejects.toThrow("callback validation failed");
    expect(tokenRequest).toBeNull();
  });

  it("fails closed for missing subject, wrong mapped types, and provider errors", async () => {
    const transaction = { state: "state-a", codeVerifier: "verifier-a" };
    const exchange = () =>
      client().exchangeAuthorizationCode({
        callbackUrl: new URL(`${REDIRECT_URI}?code=code-a&state=state-a`),
        redirectUri: REDIRECT_URI,
        transaction,
      });

    userinfo = { attributes: { email: "user@example.test" } };
    await expect(exchange()).rejects.toThrow("subject is invalid");

    userinfo = {
      attributes: { workcode: 1001, email: "user@example.test" },
    };
    await expect(exchange()).rejects.toThrow("subject is invalid");

    userinfoStatus = 500;
    await expect(exchange()).rejects.toThrow("UserInfo request failed");

    userinfoStatus = 200;
    tokenStatus = 401;
    await expect(exchange()).rejects.toThrow("token exchange failed");
  });
});

describe("OAuth2 transaction store", () => {
  it("stores expiring, single-use transactions under opaque handles", () => {
    const store = new OAuth2TransactionStore(1_000, 2);
    const now = new Date("2026-09-21T00:00:00.000Z");
    const transaction = { state: "state", codeVerifier: "verifier" };
    const handle = store.create(transaction, now);
    expect(store.consume(handle, now)).toEqual(transaction);
    expect(store.consume(handle, now)).toBeNull();
    const expired = store.create(transaction, now);
    expect(store.consume(expired, new Date(now.getTime() + 1_000))).toBeNull();
  });
});
