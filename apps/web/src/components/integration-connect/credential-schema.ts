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

/**
 * Credential names the PLATFORM produces, declared by the auth's
 * `_meta["dev.appstrate/provisioning"].provides` (AFPS §10). They stay in
 * `credentials.schema` — that schema describes the stored shape, and the server
 * validates the merged bag against it — but asking a user to type a value the
 * platform is about to mint would be worse than useless: it suggests they were
 * supposed to have one. Display only; the server strips these names from the
 * request body whatever the manifest claims.
 */
function provisionedFieldNames(auth: IntegrationManifestAuth): Set<string> {
  // The generated type declares `_meta` as `{}` (the spec leaves it open), so
  // it has to be widened before a vendor key can be read out of it.
  const meta = auth._meta as Record<string, unknown> | undefined;
  const block = meta?.["dev.appstrate/provisioning"] as { provides?: unknown } | undefined;
  const provides = block?.provides;
  return new Set(
    Array.isArray(provides) ? provides.filter((p): p is string => typeof p === "string") : [],
  );
}

/** Per-field presentation, keyed by credential name. */
export function fieldSchemas(auth: IntegrationManifestAuth): Record<string, CredentialFieldSchema> {
  const schema = auth.credentials?.schema as { properties?: Record<string, unknown> } | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== "object") return {};
  const out: Record<string, CredentialFieldSchema> = {};
  for (const [name, raw] of Object.entries(props)) {
    if (raw && typeof raw === "object") out[name] = raw;
  }
  return out;
}

/** The credential fields the form should ask the user for. */
export function deriveFieldNames(auth: IntegrationManifestAuth): string[] {
  const schema = auth.credentials?.schema as { properties?: Record<string, unknown> } | undefined;
  if (schema?.properties && typeof schema.properties === "object") {
    const provisioned = provisionedFieldNames(auth);
    return Object.keys(schema.properties).filter((name) => !provisioned.has(name));
  }
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
