// SPDX-License-Identifier: Apache-2.0

/**
 * A label for a connection with no upstream identity: the masked value (`al****.com`) of the one
 * submitted field that tells it apart, chosen by `credentials.schema`. Stored as plaintext.
 */

import { isSecretField, type JSONSchema7 } from "@appstrate/core/form";

const MIN_FINGERPRINT_LENGTH = 8;
const ADDRESS_FORMATS: ReadonlySet<string> = new Set(["uri", "hostname"]);

function isStringTyped(prop: JSONSchema7): boolean {
  const t = prop.type;
  if (t === "string") return true;
  if (Array.isArray(t)) return t.includes("string");
  return false;
}

/** `fc-xxxxxxxxf10b` → `fc****f10b`; nothing for a value shorter than 8 characters. */
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
  const fields = Object.entries(properties)
    .filter(
      ([key, prop]) => prop && isStringTyped(prop) && (required === null || required.has(key)),
    )
    .map(([key, prop]) => ({ key, prop }));
  const secrets = fields.filter(({ prop }) => isSecretField(prop));
  // An address (`https://…`, `acme.example.com`) masks to the same text for every account.
  const plain = fields.filter(
    ({ prop }) => !isSecretField(prop) && !ADDRESS_FORMATS.has(prop.format ?? ""),
  );

  if (plain.length === 1) return fingerprintSecret(credentials[plain[0]!.key]);
  if (plain.length === 0 && secrets.length === 1 && secrets[0]!.prop.format !== "password") {
    return fingerprintSecret(credentials[secrets[0]!.key]);
  }
  return undefined;
}
