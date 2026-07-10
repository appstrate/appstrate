// SPDX-License-Identifier: Apache-2.0

/**
 * HMAC-SHA256 signed run tokens.
 *
 * Format: `runId.signature` where signature = HMAC-SHA256(runId, secret).
 * Prevents token reuse from leaked runIds (logs, monitoring)
 * because the signature cannot be forged without the platform secret.
 *
 * `RUN_TOKEN_SECRET` is REQUIRED (enforced by the `@appstrate/env` schema,
 * ≥16 chars per key) — the keyring never contains an absent key, so a token
 * is always a keyed HMAC and an unkeyed hash is never produced nor accepted.
 *
 * It is a comma-separated keyring so the secret can be rotated without
 * killing in-flight runs (their tokens live as long as the run): the FIRST
 * key signs new tokens, ALL keys verify. Rotation pattern: prepend the new
 * key + restart, wait out the longest in-flight run, then drop the old key +
 * restart. The token wire format is unchanged — no kid is embedded;
 * verification simply tries every key.
 */
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@appstrate/env";

/**
 * Parse `RUN_TOKEN_SECRET` into a keyring. The env schema guarantees the
 * value is set and every comma-separated key is ≥16 chars, so the keyring
 * is always non-empty and never contains an empty/undefined key.
 */
function runTokenKeyring(): readonly string[] {
  return getEnv()
    .RUN_TOKEN_SECRET.split(",")
    .filter((k) => k.length > 0);
}

export function signRunToken(runId: string): string {
  const [activeKey] = runTokenKeyring();
  if (!activeKey) {
    // Unreachable given the env schema, but never fall through to an
    // unkeyed hash — a forgeable token is worse than a failed signing.
    throw new Error("RUN_TOKEN_SECRET produced an empty keyring");
  }
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
