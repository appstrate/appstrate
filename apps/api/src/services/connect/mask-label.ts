// SPDX-License-Identifier: Apache-2.0

/**
 * Derive a human-recognisable connection label from a submitted credential bag: the masked
 * value of its one identifying field (`al****.com` for a username, `AC****1f2e` for an account
 * id). Used only when no upstream identity (email / login) was extracted, so the user can still
 * tell two connections of the same integration apart.
 *
 * Selection is structural, by `credentials.schema`, never by field name:
 *
 *   1. Consider only `string`-typed properties.
 *   2. Drop the secrets (`isSecretField`: `writeOnly` or `format: "password"`), the fields the
 *      connect form masks. They never reach the label column, which is stored as plaintext.
 *   3. If the schema lists `required`, restrict to required fields (an optional `base_url`
 *      does not disqualify a single-identifier integration).
 *   4. Mask iff exactly ONE field survives; any other count falls back to "Connexion N".
 *
 * The mask exposes a 2-char prefix + last 4, and skips values shorter than 8 chars.
 */

import { isSecretField, type JSONSchema7 } from "@appstrate/core/form";

const MIN_FINGERPRINT_LENGTH = 8;

function isStringTyped(prop: JSONSchema7): boolean {
  const t = prop.type;
  if (t === "string") return true;
  if (Array.isArray(t)) return t.includes("string");
  return false;
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
  const properties = schema?.properties as Record<string, JSONSchema7> | undefined;
  if (!properties || typeof properties !== "object") return undefined;

  let candidates = Object.entries(properties)
    .filter(([, prop]) => prop && isStringTyped(prop) && !isSecretField(prop))
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
