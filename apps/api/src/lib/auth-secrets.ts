// SPDX-License-Identifier: Apache-2.0

/**
 * HMAC signatures for the cookies the platform itself signs, under the same
 * keyring Better Auth uses: the `BETTER_AUTH_SECRETS` values when set, else
 * `[BETTER_AUTH_SECRET]`. The first secret signs; every secret verifies, so a
 * rotation within the list keeps in-flight cookies valid. Introducing the list
 * drops `BETTER_AUTH_SECRET`: cookies it signed fail until they expire.
 *
 * Wire format: the bare base64url HMAC-SHA256.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@appstrate/env";

function keyring(): string[] {
  const env = getEnv();
  return env.BETTER_AUTH_SECRETS?.map((s) => s.value) ?? [env.BETTER_AUTH_SECRET];
}

function hmacBase64Url(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Signs `payload` with the current secret. */
export function signAuthHmac(payload: string): string {
  return hmacBase64Url(keyring()[0]!, payload);
}

/** Verifies `signature` against every secret of the keyring, in constant time. */
export function verifyAuthHmac(payload: string, signature: string): boolean {
  const actual = Buffer.from(signature, "utf8");
  return keyring().some((secret) => {
    const expected = Buffer.from(hmacBase64Url(secret, payload), "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}
