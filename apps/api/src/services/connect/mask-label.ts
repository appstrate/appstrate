// SPDX-License-Identifier: Apache-2.0

/**
 * Derive a human-recognisable connection label from a submitted credential bag: the masked
 * value of its one identifying field (`al****.com` for a username, `AC****1f2e` for an account
 * id, `fc****f10b` for the key of a key-only auth). Used only when no upstream identity (email /
 * login) was extracted, so the user can still tell two connections of the same integration apart.
 *
 * Selection is structural, by `credentials.schema`, never by field name:
 *
 *   1. Consider only `string`-typed properties, the required ones when the schema lists
 *      `required` (an optional `base_url` does not disqualify a single-key integration).
 *   2. Split them by `isSecretField`, the rule the connect form masks its inputs by.
 *   3. Exactly one non-secret field: mask it. Several: no label.
 *   4. None, and exactly one secret that is not `format: "password"`: mask that one. A
 *      password never reaches the label column, which is stored as plaintext.
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

  const listed = schema?.required;
  const required = Array.isArray(listed) && listed.length > 0 ? new Set<unknown>(listed) : null;
  const fields = Object.entries(properties).filter(
    ([key, prop]) => prop && isStringTyped(prop) && (required === null || required.has(key)),
  );
  const plain = fields.filter(([, prop]) => !isSecretField(prop));
  const secrets = fields.filter(([, prop]) => isSecretField(prop));
  const [only] =
    plain.length > 0 ? plain : secrets.filter(([, prop]) => prop.format !== "password");
  if (!only || plain.length > 1 || (plain.length === 0 && secrets.length !== 1)) return undefined;
  return fingerprintSecret(credentials[only[0]]);
}
