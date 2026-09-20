import {
  authorizationCodeGrant,
  allowInsecureRequests,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";

import { generateOpaqueToken, hashOpaqueToken } from "@agent-runtime/auth";

export interface OidcAuthorizationTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcIdentityClaims {
  subject: string;
  emailSnapshot: string | null;
  displayNameSnapshot: string | null;
}

export interface OidcClient {
  createAuthorizationRequest(redirectUri: string): Promise<{
    url: URL;
    transaction: OidcAuthorizationTransaction;
  }>;
  exchangeAuthorizationCode(input: {
    callbackUrl: URL;
    redirectUri: string;
    transaction: OidcAuthorizationTransaction;
  }): Promise<OidcIdentityClaims>;
}

export interface OidcRuntime {
  providerId: string;
  redirectUri: string;
  client: OidcClient;
  transactions: OidcTransactionStore;
}

export class OidcTransactionStore {
  readonly #transactions = new Map<
    string,
    OidcAuthorizationTransaction & { expiresAt: number }
  >();

  constructor(
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly maxTransactions = 10_000,
  ) {
    if (ttlMs <= 0 || maxTransactions <= 0) {
      throw new Error("OIDC transaction limits must be positive");
    }
  }

  create(
    transaction: OidcAuthorizationTransaction,
    currentTime: Date,
  ): string {
    this.#removeExpired(currentTime.getTime());
    if (this.#transactions.size >= this.maxTransactions) {
      throw new Error("OIDC transaction capacity exceeded");
    }
    const handle = generateOpaqueToken();
    this.#transactions.set(hashOpaqueToken(handle), {
      ...transaction,
      expiresAt: currentTime.getTime() + this.ttlMs,
    });
    return handle;
  }

  consume(
    handle: string,
    currentTime: Date,
  ): OidcAuthorizationTransaction | null {
    const key = hashOpaqueToken(handle);
    const stored = this.#transactions.get(key);
    this.#transactions.delete(key);
    if (stored === undefined || stored.expiresAt <= currentTime.getTime()) {
      return null;
    }
    return {
      state: stored.state,
      nonce: stored.nonce,
      codeVerifier: stored.codeVerifier,
    };
  }

  #removeExpired(currentTime: number): void {
    for (const [key, transaction] of this.#transactions) {
      if (transaction.expiresAt <= currentTime) this.#transactions.delete(key);
    }
  }
}

interface GenericOidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowInsecureIssuer?: boolean;
}

function snapshotClaim(value: unknown, maxLength: number): string | null {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
  ) {
    return value;
  }
  return null;
}

export class GenericOidcClient implements OidcClient {
  readonly #issuer: URL;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #allowInsecureIssuer: boolean;
  #configuration: Promise<Configuration> | null = null;

  constructor(options: GenericOidcClientOptions) {
    this.#issuer = new URL(options.issuer);
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#allowInsecureIssuer = options.allowInsecureIssuer ?? false;
  }

  async createAuthorizationRequest(redirectUri: string): Promise<{
    url: URL;
    transaction: OidcAuthorizationTransaction;
  }> {
    const configuration = await this.#getConfiguration();
    const codeVerifier = randomPKCECodeVerifier();
    const state = randomState();
    const nonce = randomNonce();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const url = buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url, transaction: { state, nonce, codeVerifier } };
  }

  async exchangeAuthorizationCode(input: {
    callbackUrl: URL;
    redirectUri: string;
    transaction: OidcAuthorizationTransaction;
  }): Promise<OidcIdentityClaims> {
    const configuration = await this.#getConfiguration();
    const callbackUrl = new URL(input.redirectUri);
    callbackUrl.search = input.callbackUrl.search;
    const tokens = await authorizationCodeGrant(configuration, callbackUrl, {
      pkceCodeVerifier: input.transaction.codeVerifier,
      expectedState: input.transaction.state,
      expectedNonce: input.transaction.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (
      claims === undefined ||
      typeof claims.sub !== "string" ||
      claims.sub.length === 0 ||
      claims.sub.length > 1_024
    ) {
      throw new Error("OIDC ID token has no valid subject");
    }
    return {
      subject: claims.sub,
      emailSnapshot: snapshotClaim(claims.email, 320),
      displayNameSnapshot:
        snapshotClaim(claims.name, 256) ??
        snapshotClaim(claims.preferred_username, 256),
    };
  }

  #getConfiguration(): Promise<Configuration> {
    if (this.#configuration === null) {
      this.#configuration = discovery(
        this.#issuer,
        this.#clientId,
        this.#clientSecret,
        undefined,
        this.#allowInsecureIssuer
          ? { execute: [allowInsecureRequests] }
          : undefined,
      ).catch((error: unknown) => {
        this.#configuration = null;
        throw error;
      });
    }
    return this.#configuration;
  }
}
