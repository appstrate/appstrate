// SPDX-License-Identifier: Apache-2.0

/**
 * HMAC-SHA256 signed run tokens.
 *
 * Format: `runId.signature` where signature = HMAC-SHA256(runId, secret).
 * Prevents token reuse from leaked runIds (logs, monitoring)
 * because the signature cannot be forged without the platform secret.
 *
 * `RUN_TOKEN_SECRET` is a comma-separated keyring so the secret can be
 * rotated without killing in-flight runs (their tokens live as long as the
 * run): the FIRST key signs new tokens, ALL keys verify. Rotation pattern:
 * prepend the new key + restart, wait out the longest in-flight run, then
 * drop the old key + restart. The token wire format is unchanged — no kid
 * is embedded; verification simply tries every key.
 */
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@appstrate/env";

/**
 * Parse `RUN_TOKEN_SECRET` into a keyring. When the secret is unset, the
 * keyring is `[undefined]` — `Bun.CryptoHasher` then degrades to an unkeyed
 * hash, preserving the documented "if unset, tokens are unsigned" behavior.
 */
function runTokenKeyring(): readonly (string | undefined)[] {
  const raw = getEnv().RUN_TOKEN_SECRET;
  if (raw === undefined) return [undefined];
  const keys = raw.split(",").filter((k) => k.length > 0);
  return keys.length > 0 ? keys : [undefined];
}

export function signRunToken(runId: string): string {
  const [activeKey] = runTokenKeyring();
  const hasher = new Bun.CryptoHasher("sha256", activeKey);
  hasher.update(runId);
  return `${runId}.${hasher.digest("hex")}`;
}

export function parseSignedToken(token: string): string | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const runId = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);
  if (!runId || !signature) return null;

  const sigBuf = Buffer.from(signature);
  for (const key of runTokenKeyring()) {
    const hasher = new Bun.CryptoHasher("sha256", key);
    hasher.update(runId);
    const expBuf = Buffer.from(hasher.digest("hex"));

    // Constant-time comparison per key
    if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) {
      return runId;
    }
  }
  return null;
}
