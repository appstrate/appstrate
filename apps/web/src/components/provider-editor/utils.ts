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
