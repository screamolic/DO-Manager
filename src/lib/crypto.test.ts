import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken, decryptTokenWithFallback } from "./crypto";

/**
 * Generate a base64-encoded 32-byte AES-GCM key.
 */
function generateKeyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...key));
}

describe("crypto", () => {
  let env: { ENCRYPTION_KEY_V1: string; ENCRYPTION_KEY_V2: string };

  beforeAll(() => {
    env = {
      ENCRYPTION_KEY_V1: generateKeyB64(),
      ENCRYPTION_KEY_V2: generateKeyB64(),
    };
  });

  it("encrypt/decrypt round-trip", async () => {
    const plaintext = "test-token-123";

    const { ciphertext, iv } = await encryptToken(plaintext, 1, env);
    const decrypted = await decryptToken(ciphertext, iv, 1, env);

    expect(decrypted).toBe(plaintext);
  });

  it("IV uniqueness — 100 encryptions produce distinct IVs", async () => {
    const ivs = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const { iv } = await encryptToken("test-token-123", 1, env);
      ivs.add(iv);
    }

    expect(ivs.size).toBe(100);
  });

  it("version fallback during rotation", async () => {
    // Encrypt with V1, decrypt with fallback starting from V2
    const { ciphertext, iv } = await encryptToken("test-token-123", 1, env);
    const decrypted = await decryptTokenWithFallback(ciphertext, iv, 2, env);

    expect(decrypted).toBe("test-token-123");
  });

  it("invalid ciphertext rejection", async () => {
    const { ciphertext, iv } = await encryptToken("test-token-123", 1, env);

    // Tamper the last character of the base64 ciphertext
    const tampered =
      ciphertext.slice(0, -1) +
      (ciphertext.slice(-1) === "A" ? "B" : "A");

    await expect(decryptToken(tampered, iv, 1, env)).rejects.toThrow();
  });

  it("wrong key version throws, fallback succeeds", async () => {
    const { ciphertext, iv } = await encryptToken("test-token-123", 1, env);

    // Direct decrypt with wrong version should throw
    await expect(decryptToken(ciphertext, iv, 2, env)).rejects.toThrow();

    // Fallback should succeed
    const decrypted = await decryptTokenWithFallback(ciphertext, iv, 2, env);
    expect(decrypted).toBe("test-token-123");
  });
});
