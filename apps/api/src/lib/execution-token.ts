// SPDX-License-Identifier: Apache-2.0

/**
 * HMAC-SHA256 signed execution tokens.
 *
 * Format: `executionId.signature` where signature = HMAC-SHA256(executionId, secret).
 * Prevents token reuse from leaked executionIds (logs, monitoring)
 * because the signature cannot be forged without the platform secret.
 */
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@appstrate/env";

export function signExecutionToken(executionId: string): string {
  const hasher = new Bun.CryptoHasher("sha256", getEnv().EXECUTION_TOKEN_SECRET);
  hasher.update(executionId);
  return `${executionId}.${hasher.digest("hex")}`;
}

export function parseSignedToken(token: string): string | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const executionId = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);
  if (!executionId || !signature) return null;

  const hasher = new Bun.CryptoHasher("sha256", getEnv().EXECUTION_TOKEN_SECRET);
  hasher.update(executionId);
  const expected = hasher.digest("hex");

  // Constant-time comparison
  if (signature.length !== expected.length) return null;
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  return timingSafeEqual(sigBuf, expBuf) ? executionId : null;
}
