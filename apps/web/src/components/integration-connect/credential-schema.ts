// SPDX-License-Identifier: Apache-2.0

/**
 * Reading an integration auth's `credentials.schema` — which fields the connect
 * form asks for, and how each one presents itself.
 *
 * Separate from the component because these are pure functions over manifest
 * data, testable without rendering, and because a component file that also
 * exports helpers breaks fast refresh.
 */

import type { JSONSchema7 } from "@appstrate/core/form";
import type { IntegrationManifestAuth } from "../../hooks/use-integrations";

const SECRET: JSONSchema7 = { type: "string", writeOnly: true };

/** The fields of an auth that declares no `credentials.schema`, by auth type (AFPS §7.5). */
const CANONICAL_FIELDS: Record<string, Record<string, JSONSchema7>> = {
  api_key: { api_key: SECRET },
  basic: { username: { type: "string" }, password: SECRET },
  mtls: { client_cert: { type: "string" }, client_key: SECRET },
};

/** The declared `credentials.schema.properties` — present-but-empty names no field. */
function declared(auth: IntegrationManifestAuth): Record<string, unknown> | undefined {
  const props = (auth.credentials?.schema as { properties?: unknown } | undefined)?.properties;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : undefined;
}

/** Each field's schema, keyed by credential name: the declared one, else the auth type's own. */
export function fieldSchemas(auth: IntegrationManifestAuth): Record<string, JSONSchema7> {
  return Object.fromEntries(
    Object.entries(declared(auth) ?? CANONICAL_FIELDS[auth.type] ?? {}).filter(
      ([, raw]) => raw && typeof raw === "object",
    ),
  ) as Record<string, JSONSchema7>;
}

/**
 * The declared fields, required ones first in `required` order; the auth type's canonical set
 * only when none are declared. The server returns `properties` in jsonb key order (shortest key
 * first), not the manifest's, so the `required` array is the only author order that survives.
 */
export function deriveFieldNames(auth: IntegrationManifestAuth): string[] {
  const props = declared(auth);
  if (props) {
    const listed = (auth.credentials?.schema as { required?: unknown } | undefined)?.required;
    const required = Array.isArray(listed)
      ? listed.filter(
          (f): f is string =>
            typeof f === "string" && Object.prototype.hasOwnProperty.call(props, f),
        )
      : [];
    const first = new Set(required);
    return [...first, ...Object.keys(props).filter((f) => !first.has(f))];
  }
  return Object.keys(CANONICAL_FIELDS[auth.type] ?? {});
}

/**
 * Seed values for a connect form: every field the auth gives a `default`.
 * Seeding is the only way a default reaches the screen, which is what keeps
 * what the user sees and what the form submits the same value.
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
