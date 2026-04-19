// SPDX-License-Identifier: Apache-2.0

import { fieldsToSchema } from "../agent-editor/utils";
import type { SchemaField } from "../agent-editor/schema-section";

/** Return a new definition with `credentials` written from fields, or removed if empty. */
export function writeCredentialsToDef(
  def: Record<string, unknown>,
  fields: SchemaField[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...def };
  const wrapper = fieldsToSchema(fields, "credentials");
  if (wrapper) {
    const existing = (def.credentials ?? {}) as Record<string, unknown>;
    next.credentials = { ...existing, schema: wrapper.schema };
  } else {
    delete next.credentials;
  }
  return next;
}

/** Patch `definition.credentials` (canonical nested shape). */
export function patchCredentialsInDef(
  def: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existing = (def.credentials ?? {}) as Record<string, unknown>;
  return { ...def, credentials: { ...existing, ...patch } };
}

/**
 * Migrate legacy flat `definition.credentialFieldName` to canonical nested
 * `definition.credentials.fieldName` on load. Produces a manifest in the
 * canonical shape so saves don't re-introduce the flat form.
 *
 * Canonical wins: if both forms exist, the nested `credentials.fieldName` is
 * preserved and the flat field is dropped silently.
 */
export function migrateLegacyFieldName(def: Record<string, unknown>): Record<string, unknown> {
  if (!("credentialFieldName" in def)) return def;
  const flat = def.credentialFieldName as string | undefined;
  const next: Record<string, unknown> = { ...def };
  delete next.credentialFieldName;
  if (flat) {
    const existing = (next.credentials ?? {}) as Record<string, unknown>;
    if (existing.fieldName === undefined) {
      next.credentials = { ...existing, fieldName: flat };
    }
  }
  return next;
}
