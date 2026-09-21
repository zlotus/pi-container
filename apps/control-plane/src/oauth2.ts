import { generateOpaqueToken, hashOpaqueToken } from "@agent-runtime/auth";

import type { ExternalIdentityProfile } from "./external-auth.js";

export interface OAuth2AuthorizationTransaction {
  state: string;
  codeVerifier: string;
}

export interface OAuth2Client {
  createAuthorizationRequest(redirectUri: string): Promise<{
    url: URL;
    transaction: OAuth2AuthorizationTransaction;
  }>;
  exchangeAuthorizationCode(input: {
    callbackUrl: URL;
    redirectUri: string;
    transaction: OAuth2AuthorizationTransaction;
  }): Promise<ExternalIdentityProfile>;
}

export interface OAuth2Runtime {
  providerId: string;
  redirectUri: string;
  client: OAuth2Client;
  transactions: OAuth2TransactionStore;
  autoProvision: boolean;
  allowedDomains: readonly string[];
}

export class OAuth2TransactionStore {
  readonly #transactions = new Map<
    string,
    OAuth2AuthorizationTransaction & { expiresAt: number }
  >();

  constructor(
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly maxTransactions = 10_000,
  ) {
    if (ttlMs <= 0 || maxTransactions <= 0) {
      throw new Error("OAuth2 transaction limits must be positive");
    }
  }

  create(transaction: OAuth2AuthorizationTransaction, currentTime: Date): string {
    this.#removeExpired(currentTime.getTime());
    if (this.#transactions.size >= this.maxTransactions) {
      throw new Error("OAuth2 transaction capacity exceeded");
    }
    const handle = generateOpaqueToken();
    this.#transactions.set(hashOpaqueToken(handle), {
      ...transaction,
      expiresAt: currentTime.getTime() + this.ttlMs,
    });
    return handle;
  }

  consume(handle: string, currentTime: Date): OAuth2AuthorizationTransaction | null {
    const key = hashOpaqueToken(handle);
    const stored = this.#transactions.get(key);
    this.#transactions.delete(key);
    if (stored === undefined || stored.expiresAt <= currentTime.getTime()) return null;
    return { state: stored.state, codeVerifier: stored.codeVerifier };
  }

  #removeExpired(currentTime: number): void {
    for (const [key, transaction] of this.#transactions) {
      if (transaction.expiresAt <= currentTime) this.#transactions.delete(key);
    }
  }
}

interface GenericOAuth2ClientOptions {
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  subjectField: string;
  usernameField: string | null;
  emailField: string | null;
  displayNameField: string | null;
  userinfoTokenMethod?: "bearer" | "query";
  requestTimeoutMs?: number;
}

function randomBase64Url(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(values).toString("base64url");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

function normalizeJsonPath(path: string): string[] {
  const normalized = path.replace(
    /\[\s*"([A-Za-z0-9_-]+)"\s*\]/g,
    ".$1",
  );
  return normalized.split(".").filter((segment) => segment !== "");
}

function readJsonPath(
  value: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = value;
  for (const segment of normalizeJsonPath(path)) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function mappedString(
  value: Record<string, unknown>,
  path: string | null,
  options: { required: boolean; maxLength: number; label: string },
): string | null {
  if (path === null) return null;
  const mapped = readJsonPath(value, path);
  if (mapped === undefined && !options.required) return null;
  if (
    typeof mapped !== "string" ||
    mapped.length === 0 ||
    mapped.length > options.maxLength
  ) {
    throw new Error(`OAuth2 UserInfo ${options.label} is invalid`);
  }
  return mapped;
}

export class GenericOAuth2UserInfoClient implements OAuth2Client {
  readonly #authorizationUrl: URL;
  readonly #tokenUrl: URL;
  readonly #userinfoUrl: URL;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #scope: string;
  readonly #subjectField: string;
  readonly #usernameField: string | null;
  readonly #emailField: string | null;
  readonly #displayNameField: string | null;
  readonly #userinfoTokenMethod: "bearer" | "query";
  readonly #requestTimeoutMs: number;

  constructor(options: GenericOAuth2ClientOptions) {
    this.#authorizationUrl = new URL(options.authorizationUrl);
    this.#tokenUrl = new URL(options.tokenUrl);
    this.#userinfoUrl = new URL(options.userinfoUrl);
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#scope = options.scope;
    this.#subjectField = options.subjectField;
    this.#usernameField = options.usernameField;
    this.#emailField = options.emailField;
    this.#displayNameField = options.displayNameField;
    this.#userinfoTokenMethod = options.userinfoTokenMethod ?? "bearer";
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async createAuthorizationRequest(redirectUri: string): Promise<{
    url: URL;
    transaction: OAuth2AuthorizationTransaction;
  }> {
    const state = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const url = new URL(this.#authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (this.#scope !== "") url.searchParams.set("scope", this.#scope);
    return { url, transaction: { state, codeVerifier } };
  }

  async exchangeAuthorizationCode(input: {
    callbackUrl: URL;
    redirectUri: string;
    transaction: OAuth2AuthorizationTransaction;
  }): Promise<ExternalIdentityProfile> {
    const code = input.callbackUrl.searchParams.get("code");
    const state = input.callbackUrl.searchParams.get("state");
    if (code === null || code === "" || state !== input.transaction.state) {
      throw new Error("OAuth2 callback validation failed");
    }

    const tokenResponse = await fetch(this.#tokenUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: input.redirectUri,
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code_verifier: input.transaction.codeVerifier,
      }),
    });
    if (!tokenResponse.ok) throw new Error("OAuth2 token exchange failed");
    const tokenPayload: unknown = await tokenResponse.json();
    if (
      typeof tokenPayload !== "object" ||
      tokenPayload === null ||
      Array.isArray(tokenPayload)
    ) {
      throw new Error("OAuth2 token response is invalid");
    }
    const accessToken = (tokenPayload as Record<string, unknown>).access_token;
    const tokenType = (tokenPayload as Record<string, unknown>).token_type;
    if (
      typeof accessToken !== "string" ||
      accessToken.length === 0 ||
      accessToken.length > 16_384 ||
      (tokenType !== undefined &&
        (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer"))
    ) {
      throw new Error("OAuth2 access token is invalid");
    }

    const userinfoUrl = new URL(this.#userinfoUrl);
    const userinfoHeaders: Record<string, string> = { accept: "application/json" };
    if (this.#userinfoTokenMethod === "query") {
      userinfoUrl.searchParams.set("access_token", accessToken);
    } else {
      userinfoHeaders.authorization = `Bearer ${accessToken}`;
    }
    const userinfoResponse = await fetch(userinfoUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      headers: userinfoHeaders,
    });
    if (!userinfoResponse.ok) throw new Error("OAuth2 UserInfo request failed");
    const userinfo: unknown = await userinfoResponse.json();
    if (typeof userinfo !== "object" || userinfo === null || Array.isArray(userinfo)) {
      throw new Error("OAuth2 UserInfo response is invalid");
    }
    const profile = userinfo as Record<string, unknown>;
    return {
      subject: mappedString(profile, this.#subjectField, {
        required: true,
        maxLength: 1_024,
        label: "subject",
      }) as string,
      usernameSnapshot: mappedString(profile, this.#usernameField, {
        required: false,
        maxLength: 256,
        label: "username",
      }),
      emailSnapshot: mappedString(profile, this.#emailField, {
        required: false,
        maxLength: 320,
        label: "email",
      }),
      displayNameSnapshot: mappedString(profile, this.#displayNameField, {
        required: false,
        maxLength: 256,
        label: "display name",
      }),
    };
  }
}
