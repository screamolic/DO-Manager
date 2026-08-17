/**
 * AES-GCM 256-bit encryption/decryption for DO API tokens.
 *
 * Keys are stored as base64-encoded 32-byte values in Workers Secrets
 * (ENCRYPTION_KEY_V1, ENCRYPTION_KEY_V2). Uses Web Crypto API
 * (not Node.js crypto) for Cloudflare Workers compatibility.
 */

/**
 * KeyUsage union per Web Crypto spec. Declared locally because the
 * project's tsconfig lib is ES2022-only (no DOM lib exposes this type).
 */
type KeyUsage =
  | "encrypt"
  | "decrypt"
  | "sign"
  | "verify"
  | "deriveKey"
  | "deriveBits"
  | "wrapKey"
  | "unwrapKey";

/**
 * Decode a base64 secret string into a raw CryptoKey for AES-GCM.
 */
async function decodeKey(
  base64Key: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Encrypt a plaintext DO API token using AES-GCM 256-bit.
 *
 * @returns The ciphertext and IV, both as base64 strings.
 */
export async function encryptToken(
  plaintext: string,
  keyVersion: 1 | 2,
  env: { ENCRYPTION_KEY_V1?: string; ENCRYPTION_KEY_V2?: string },
): Promise<{ ciphertext: string; iv: string }> {
  const secret = keyVersion === 1 ? env.ENCRYPTION_KEY_V1 : env.ENCRYPTION_KEY_V2;
  if (!secret) {
    throw new Error(`ENCRYPTION_KEY_V${keyVersion} is not set`);
  }

  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const key = await decodeKey(secret, ["encrypt"]);
  const encoded = new TextEncoder().encode(plaintext);

  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt a ciphertext using the specified key version.
 * Throws on auth tag mismatch (tampered data or wrong key).
 */
export async function decryptToken(
  ciphertext: string,
  iv: string,
  keyVersion: 1 | 2,
  env: { ENCRYPTION_KEY_V1?: string; ENCRYPTION_KEY_V2?: string },
): Promise<string> {
  const secret = keyVersion === 1 ? env.ENCRYPTION_KEY_V1 : env.ENCRYPTION_KEY_V2;
  if (!secret) {
    throw new Error(`ENCRYPTION_KEY_V${keyVersion} is not set`);
  }

  const key = await decodeKey(secret, ["decrypt"]);
  const ivBytes = base64ToBytes(iv);
  const ciphertextBytes = base64ToBytes(ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    ciphertextBytes,
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Decrypt with key-version fallback for rotation windows.
 *
 * Tries the specified `keyVersion` first.  If that fails (auth tag mismatch),
 * falls back to the other key version.  If both fail, throws the original error.
 */
export async function decryptTokenWithFallback(
  ciphertext: string,
  iv: string,
  keyVersion: 1 | 2,
  env: { ENCRYPTION_KEY_V1?: string; ENCRYPTION_KEY_V2?: string },
): Promise<string> {
  try {
    return await decryptToken(ciphertext, iv, keyVersion, env);
  } catch (primaryErr) {
    const fallbackVersion: 1 | 2 = keyVersion === 1 ? 2 : 1;
    try {
      return await decryptToken(ciphertext, iv, fallbackVersion, env);
    } catch {
      throw primaryErr;
    }
  }
}
