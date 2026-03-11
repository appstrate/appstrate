/**
 * HMAC-SHA256 signed execution tokens.
 *
 * Format: `executionId.signature` where signature = HMAC-SHA256(executionId, secret).
 * Prevents token reuse from leaked executionIds (logs, monitoring)
 * because the signature cannot be forged without the platform secret.
 */
import { getEnv } from "@appstrate/env";

export function signExecutionToken(executionId: string): string {
  const secret = getEnv().BETTER_AUTH_SECRET;
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(executionId);
  return `${executionId}.${hasher.digest("hex")}`;
}

export function parseSignedToken(token: string): string | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const executionId = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);
  if (!executionId || !signature) return null;

  const secret = getEnv().BETTER_AUTH_SECRET;
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(executionId);
  const expected = hasher.digest("hex");

  // Constant-time comparison
  if (signature.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return diff === 0 ? executionId : null;
}
