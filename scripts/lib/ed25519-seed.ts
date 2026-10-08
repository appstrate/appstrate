// SPDX-License-Identifier: Apache-2.0

/**
 * The signing secrets of this repository are base64 raw 32-byte Ed25519 seeds
 * (GitHub Actions secrets), not PEM. Zero dependencies: `node:crypto` only.
 */

import { createPrivateKey, type KeyObject } from "node:crypto";

/**
 * PKCS#8 DER prefix of an Ed25519 private key (RFC 8410). Appending the raw
 * seed yields a complete DER document `node:crypto` can import.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The private key of a base64 raw 32-byte seed. Throws on anything else. */
export function privateKeyFromSeed(seedBase64: string): KeyObject {
  const seed = Buffer.from(seedBase64.trim(), "base64");
  if (seed.length !== 32) {
    throw new Error(`expected a base64 raw 32-byte Ed25519 seed (got ${seed.length} bytes)`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The base64 raw seed of an Ed25519 private key. */
export function seedOfPrivateKey(privateKey: KeyObject): string {
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  return pkcs8.subarray(PKCS8_ED25519_PREFIX.length).toString("base64");
}
