import { describe, it, expect, beforeAll, vi, beforeEach } from "vitest";
import { validateAccessJWT } from "./auth";
import {
  generateKeyPair,
  SignJWT,
  exportJWK,
  createLocalJWKSet,
  type JWK,
} from "jose";

// jose v6 no longer exports CryptoKeyPair; infer it from generateKeyPair.
type CryptoKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

// Hoisted mock — vitest hoists vi.mock() before all code, so variables
// used in the factory must use vi.hoisted().
const { mockCreateRemoteJWKSet } = vi.hoisted(() => ({
  mockCreateRemoteJWKSet: vi.fn(),
}));

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: mockCreateRemoteJWKSet,
  };
});

describe("validateAccessJWT", () => {
  let keyPair: CryptoKeyPair;
  const env = { TEAM_DOMAIN: "test.cloudflareaccess.com" };

  beforeAll(async () => {
    keyPair = await generateKeyPair("RS256");
  });

  beforeEach(() => {
    mockCreateRemoteJWKSet.mockReset();
  });

  it("valid JWT passes and returns email + sub", async () => {
    const jwt = await new SignJWT({ email: "user@test.com", sub: "user-123" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://test.cloudflareaccess.com")
      .setAudience("test-aud")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keyPair.privateKey);

    // Wire the mock JWKS resolver from the same public key
    const jwk = await exportJWK(keyPair.publicKey);
    const localJWKS = createLocalJWKSet({
      keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] as JWK[],
    });
    mockCreateRemoteJWKSet.mockReturnValue(localJWKS);

    const request = new Request("https://example.com", {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });

    const result = await validateAccessJWT(request, env);

    expect(result.email).toBe("user@test.com");
    expect(result.sub).toBe("user-123");
  });

  it("expired JWT is rejected with 403", async () => {
    const jwt = await new SignJWT({ email: "user@test.com", sub: "user-123" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://test.cloudflareaccess.com")
      .setAudience("test-aud")
      .setIssuedAt()
      .setExpirationTime("0s") // already expired
      .sign(keyPair.privateKey);

    const jwk = await exportJWK(keyPair.publicKey);
    const localJWKS = createLocalJWKSet({
      keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] as JWK[],
    });
    mockCreateRemoteJWKSet.mockReturnValue(localJWKS);

    const request = new Request("https://example.com", {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });

    let caught: unknown;
    try {
      await validateAccessJWT(request, env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as Error & { status?: number }).status).toBe(403);
    expect((caught as Error).message).toMatch(/expired/i);
  });

  it("missing header returns 403", async () => {
    const request = new Request("https://example.com");

    let caught: unknown;
    try {
      await validateAccessJWT(request, env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as Error & { status?: number }).status).toBe(403);
    expect((caught as Error).message).toMatch(/No JWT assertion header/i);
  });

  it("wrong signature is rejected with 403", async () => {
    // Generate a DIFFERENT key pair for signing vs. verifying
    const wrongKeyPair = await generateKeyPair("RS256");

    const jwt = await new SignJWT({ email: "user@test.com", sub: "user-123" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://test.cloudflareaccess.com")
      .setAudience("test-aud")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(wrongKeyPair.privateKey);

    // The JWKS resolver uses the ORIGINAL (correct) key pair
    const jwk = await exportJWK(keyPair.publicKey);
    const localJWKS = createLocalJWKSet({
      keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] as JWK[],
    });
    mockCreateRemoteJWKSet.mockReturnValue(localJWKS);

    const request = new Request("https://example.com", {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });

    let caught: unknown;
    try {
      await validateAccessJWT(request, env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as Error & { status?: number }).status).toBe(403);
    expect((caught as Error).message).toMatch(/signature/i);
  });
});
