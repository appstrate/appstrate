/**
 * Versioned auth secrets — the foundation for online rotation of every
 * cookie/HMAC the platform itself signs.
 *
 * Two env vars drive the model:
 *   - `BETTER_AUTH_ACTIVE_KID` — the kid used when signing new tokens.
 *   - `BETTER_AUTH_SECRETS`     — JSON `{ kid: secret }` map of every
 *                                  secret a verifier should accept.
 *
 * Backward compat: if `BETTER_AUTH_SECRETS` is empty (the default), we
 * derive `{ [BETTER_AUTH_ACTIVE_KID]: BETTER_AUTH_SECRET }` so existing
 * deployments keep working unchanged.
 *
 * Signature wire format used by `signAuthHmac` / `verifyAuthHmac`:
 *
 *     <kid>$<base64url-hmac>
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@appstrate/env";

let _cache: { active: string; map: Record<string, string> } | null = null;

function loadSecrets(): { active: string; map: Record<string, string> } {
  if (_cache) return _cache;
  const env = getEnv();
  const map: Record<string, string> = { ...env.BETTER_AUTH_SECRETS };
  const activeKid = env.BETTER_AUTH_ACTIVE_KID;
  if (!map[activeKid]) {
    map[activeKid] = env.BETTER_AUTH_SECRET;
  }
  _cache = { active: activeKid, map };
  return _cache;
}

/** Returns the secret matching `BETTER_AUTH_ACTIVE_KID` — pass to Better Auth. */
export function getActiveAuthSecret(): string {
  const { active, map } = loadSecrets();
  const secret = map[active];
  if (!secret) {
    throw new Error(`No secret configured for active kid '${active}'`);
  }
  return secret;
}

function hmacBase64Url(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Signs `payload` with the active secret. Returns `<kid>$<sig>`. */
export function signAuthHmac(payload: string): string {
  const { active } = loadSecrets();
  const sig = hmacBase64Url(getActiveAuthSecret(), payload);
  return `${active}$${sig}`;
}

/**
 * Verifies a signature against any known secret. Requires the prefixed
 * `<kid>$<sig>` form — un-prefixed signatures are rejected.
 */
export function verifyAuthHmac(payload: string, signature: string): boolean {
  const { map } = loadSecrets();

  const sep = signature.indexOf("$");
  if (sep < 0) return false;
  const kid = signature.slice(0, sep);
  const sig = signature.slice(sep + 1);
  const secret = map[kid];
  if (!secret) return false;
  return constantTimeEquals(hmacBase64Url(secret, payload), sig);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Test-only: clear the memoised secret map (used by env-overriding tests). */
export function _resetAuthSecretsCache(): void {
  _cache = null;
}
