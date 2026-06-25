// SPDX-License-Identifier: Apache-2.0

/**
 * Derive a human-recognisable connection label from a pasted credential bag —
 * a partially-masked fingerprint of the secret (e.g. `fc****f10b` for a
 * Firecrawl key `fc-xxxxxxxxf10b`). Used only when no upstream identity
 * (email / login) was extracted, so the user can still tell two API-key
 * connections of the same integration apart without us inventing
 * "Connexion 2" / "Connexion 3".
 *
 * Selection is structural, NOT name-based (no `api_key`/`token` allow-list —
 * that would be fragile + per-provider). We mask the credential iff the auth
 * declares exactly one fingerprintable secret field:
 *
 *   1. Consider only `string`-typed properties of `credentials.schema`.
 *   2. Drop `format:"password"` / `writeOnly:true` fields — those are the
 *      never-show class (a human account password; revealing even the last 4
 *      is a real leak). They must NEVER reach a plaintext label column.
 *   3. If the schema lists `required`, restrict to required fields (an
 *      optional `base_url` shouldn't disqualify a single-key integration).
 *   4. Mask iff exactly ONE field survives; ambiguous multi-secret auths
 *      (Twilio sid+token, Shopify domain+token) fall back to "Connexion N".
 *
 * The label is stored as plaintext (the `label` column is not encrypted), so
 * the mask only ever exposes a 2-char prefix + last 4 — the industry-standard
 * fingerprint (Stripe/AWS/GitHub). Values shorter than 8 chars are skipped to
 * avoid leaking too large a fraction of a short secret.
 */

const MIN_FINGERPRINT_LENGTH = 8;

interface SchemaProperty {
  type?: unknown;
  format?: unknown;
  writeOnly?: unknown;
}

function isStringTyped(prop: SchemaProperty): boolean {
  const t = prop.type;
  if (t === "string") return true;
  if (Array.isArray(t)) return t.includes("string");
  return false;
}

function isNeverShow(prop: SchemaProperty): boolean {
  return prop.format === "password" || prop.writeOnly === true;
}

/**
 * `fc-xxxxxxxxf10b` → `fc****f10b`. Returns undefined for non-strings or
 * values too short to mask without leaking most of the secret.
 */
export function fingerprintSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length < MIN_FINGERPRINT_LENGTH) return undefined;
  return `${value.slice(0, 2)}****${value.slice(-4)}`;
}

export function maskCredentialLabel(
  schema: Record<string, unknown> | undefined,
  credentials: Record<string, unknown>,
): string | undefined {
  const properties = schema?.properties as Record<string, SchemaProperty> | undefined;
  if (!properties || typeof properties !== "object") return undefined;

  let candidates = Object.entries(properties)
    .filter(([, prop]) => prop && isStringTyped(prop) && !isNeverShow(prop))
    .map(([key]) => key);

  const required = schema?.required;
  if (Array.isArray(required) && required.length > 0) {
    const requiredSet = new Set(required.filter((r): r is string => typeof r === "string"));
    candidates = candidates.filter((key) => requiredSet.has(key));
  }

  const only = candidates[0];
  if (candidates.length !== 1 || only === undefined) return undefined;
  return fingerprintSecret(credentials[only]);
}
