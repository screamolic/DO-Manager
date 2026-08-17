/**
 * Cloudflare Access JWT validation.
 *
 * Uses the `jose` library to verify JWTs signed by Cloudflare Access
 * against the team's JWKS endpoint at
 * `https://<TEAM_DOMAIN>/cdn-cgi/access/certs`.
 */

import { createRemoteJWKSet, jwtVerify, errors } from "jose";

/**
 * Validate the CF-Access-Jwt-Assertion header from a request.
 *
 * @returns The verified JWT payload's `email` and `sub` claims.
 * @throws An error with `.status` set to 403 on any validation failure.
 */
export async function validateAccessJWT(
  request: Request,
  env: { TEAM_DOMAIN?: string },
): Promise<{ email: string; sub: string }> {
  const jwt = request.headers.get("CF-Access-Jwt-Assertion");
  if (!jwt) {
    throw Object.assign(new Error("No JWT assertion header"), { status: 403 });
  }

  if (!env.TEAM_DOMAIN) {
    throw Object.assign(new Error("TEAM_DOMAIN is not configured"), {
      status: 500,
    });
  }

  const JWKS = createRemoteJWKSet(
    new URL(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`),
  );

  try {
    const { payload } = await jwtVerify(jwt, JWKS);

    const email = payload.email as string | undefined;
    const sub = payload.sub as string | undefined;

    if (!email || !sub) {
      throw Object.assign(new Error("Invalid JWT payload: missing email or sub"), {
        status: 403,
      });
    }

    return { email, sub };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw Object.assign(new Error("JWT has expired"), { status: 403 });
    }
    if (err instanceof errors.JWSSignatureVerificationFailed) {
      throw Object.assign(new Error("JWT signature verification failed"), {
        status: 403,
      });
    }

    // If already a structured error with status, re-throw as-is
    if (err && typeof err === "object" && "status" in err) {
      throw err;
    }

    throw Object.assign(
      new Error(`JWT validation failed: ${(err as Error).message ?? "unknown error"}`),
      { status: 403 },
    );
  }
}
