// SPDX-License-Identifier: Apache-2.0

/**
 * Reading an integration auth's `credentials.schema` — which fields the connect
 * form asks for, and how each one presents itself.
 *
 * Separate from the component because these are pure functions over manifest
 * data, testable without rendering, and because a component file that also
 * exports helpers breaks fast refresh.
 */

import type { IntegrationManifestAuth } from "../../hooks/use-integrations";

/** The `title` / `description` / `default` an auth declares for one credential. */
export interface CredentialFieldSchema {
  title?: string;
  description?: string;
  default?: string;
}

/** The auth's `credentials.schema.properties`, or `undefined` if it declares none. */
function schemaProperties(auth: IntegrationManifestAuth): Record<string, unknown> | undefined {
  const schema = auth.credentials?.schema as { properties?: Record<string, unknown> } | undefined;
  const props = schema?.properties;
  return props && typeof props === "object" ? props : undefined;
}

/** Per-field presentation, keyed by credential name. */
export function fieldSchemas(auth: IntegrationManifestAuth): Record<string, CredentialFieldSchema> {
  const props = schemaProperties(auth);
  if (!props) return {};
  const out: Record<string, CredentialFieldSchema> = {};
  for (const [name, raw] of Object.entries(props)) {
    if (raw && typeof raw === "object") out[name] = raw;
  }
  return out;
}

/**
 * The credential fields the form should ask the user for: the declared
 * properties, verbatim.
 *
 * Nothing is filtered out here. A credential the PLATFORM mints is already
 * absent from the schema `GET /api/integrations/connect/context` serves — the
 * server owns that list, since which names a provisioning kind owns is a
 * property of the provisioner, not of the manifest.
 */
export function deriveFieldNames(auth: IntegrationManifestAuth): string[] {
  const props = schemaProperties(auth);
  if (props) return Object.keys(props);
  if (auth.type === "api_key") return ["api_key"];
  if (auth.type === "basic") return ["username", "password"];
  // AFPS §7.5 — mtls credential schema SHOULD describe a client cert and
  // private key (chain optional). When the manifest omits explicit
  // `credentials.schema.properties`, fall back to the two canonical fields so
  // the form still renders inputs.
  if (auth.type === "mtls") return ["client_cert", "client_key"];
  return [];
}

/**
 * Seed values for a connect form: every field the auth gives a `default`. The
 * form SHOWS a default, so it has to SUBMIT it too — rendering one without
 * seeding state would put a value under the user's eyes that never leaves the
 * browser.
 */
export function initialCredentialValues(auth: IntegrationManifestAuth): Record<string, string> {
  const schemas = fieldSchemas(auth);
  const out: Record<string, string> = {};
  for (const field of deriveFieldNames(auth)) {
    const declared = schemas[field]?.default;
    if (typeof declared === "string" && declared !== "") out[field] = declared;
  }
  return out;
}
