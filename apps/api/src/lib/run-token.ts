// SPDX-License-Identifier: Apache-2.0

/**
 * HMAC-SHA256 signed run tokens.
 *
 * Format: `runId.signature` where signature = HMAC-SHA256(runId, secret).
 * Prevents token reuse from leaked runIds (logs, monitoring)
 * because the signature cannot be forged without the platform secret.
 */
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@appstrate/env";

export function signRunToken(runId: string): string {
  const hasher = new Bun.CryptoHasher("sha256", getEnv().RUN_TOKEN_SECRET);
  hasher.update(runId);
  return `${runId}.${hasher.digest("hex")}`;
}

export function parseSignedToken(token: string): string | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const runId = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);
  if (!runId || !signature) return null;

  const hasher = new Bun.CryptoHasher("sha256", getEnv().RUN_TOKEN_SECRET);
  hasher.update(runId);
  const expected = hasher.digest("hex");

  // Constant-time comparison
  if (signature.length !== expected.length) return null;
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  return timingSafeEqual(sigBuf, expBuf) ? runId : null;
}
