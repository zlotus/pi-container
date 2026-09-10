import { describe, expect, it } from "vitest";

import {
  constantTimeTextEqual,
  deriveCsrfToken,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  verifyPassword,
} from "./index.js";

describe("password hashing", () => {
  it("hashes and verifies a password using scrypt", async () => {
    const encoded = await hashPassword("correct horse battery staple");

    expect(encoded).not.toContain("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", encoded),
    ).resolves.toBe(true);
    await expect(verifyPassword("incorrect password", encoded)).resolves.toBe(
      false,
    );
  });

  it("rejects malformed hashes", async () => {
    await expect(verifyPassword("anything", "not-a-hash")).resolves.toBe(false);
  });
});

describe("session tokens", () => {
  it("creates opaque tokens and stable one-way hashes", () => {
    const token = generateOpaqueToken();

    expect(token).toHaveLength(43);
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
    expect(hashOpaqueToken(token)).not.toBe(token);
  });

  it("derives a session-bound CSRF token", () => {
    const first = deriveCsrfToken("session-a", "a sufficiently long secret");
    const second = deriveCsrfToken("session-b", "a sufficiently long secret");

    expect(first).not.toBe(second);
    expect(constantTimeTextEqual(first, first)).toBe(true);
    expect(constantTimeTextEqual(first, second)).toBe(false);
  });
});
