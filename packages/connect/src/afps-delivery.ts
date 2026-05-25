// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS 2.0 `delivery.http` resolver (snake_case, value-template shape).
 *
 * The AFPS 2.0 `auths.{key}.delivery.http` block (snake_case) is:
 *
 *   { in: "header", name }              header channel + name
 *   { prefix }                          value prefix, e.g. "Bearer "
 *   { value: "{$credential.<field>}" }  value template
 *   { value: "<template>", encoding }   base64-encoded template
 *   { allow_server_override }           strip caller override when false
 *
 * The value is a TEMPLATE referencing credential fields via the
 * `{$credential.<field>}` syntax (the same syntax `delivery.env`/`delivery.files`
 * use). This resolver renders that template against an auth's decrypted
 * credential bag and returns a {@link HttpDeliveryPlan} — the SAME plan shape
 * the rest of the pipeline (sidecar MITM listener, api-call credentials) already
 * consumes, so downstream consumers are untouched.
 *
 * `resolveAfpsHttpDelivery` reads the AFPS 2.0 manifest `delivery.http` block
 * directly; `resolveHttpDelivery` (from `@appstrate/afps-runtime`) is the
 * lower-level plan resolver fed by the runtime plan-input shape (callers
 * project the 2.0 block into it). Both emit the same `HttpDeliveryPlan`.
 */

import type { HttpDeliveryPlan } from "./integration-credentials.ts";

/**
 * Subset of the AFPS 2.0 `auths.{key}.delivery.http` block this resolver
 * consumes. `value` is a template; `{$credential.<field>}` references resolve
 * against the auth's credential bag.
 */
export interface AfpsHttpDelivery {
  /** Delivery channel discriminant — always `"header"` for http delivery. */
  in?: "header";
  /** Header name. */
  name?: string;
  /** Header value prefix, e.g. `"Bearer "`. */
  prefix?: string;
  /** Value template with `{$credential.<field>}` refs. */
  value?: string;
  /** Optional post-render encoding — base64 of the rendered value. */
  encoding?: "base64";
  /** Mirrors manifest; default `false` → proxy strips caller overrides. */
  allow_server_override?: boolean;
}

/** Auth-type defaults — the implicit header injection AFPS §7.6 grants per type. */
const AUTH_TYPE_DEFAULTS: Readonly<
  Record<string, { name: string; prefix: string; value: string }>
> = {
  oauth2: { name: "Authorization", prefix: "Bearer ", value: "{$credential.access_token}" },
  api_key: { name: "X-Api-Key", prefix: "", value: "{$credential.api_key}" },
  basic: { name: "Authorization", prefix: "Basic ", value: "" },
  custom: { name: "", prefix: "", value: "" },
};

const CREDENTIAL_REF = /\{\$credential\.([A-Za-z0-9_]+)\}/g;

/**
 * Render a `{$credential.<field>}` value template against a credential bag.
 * Unknown refs render empty (a missing field means "no value to inject"),
 * mirroring the `delivery.http` rendering policy used elsewhere.
 */
function renderCredentialTemplate(
  template: string,
  fields: Readonly<Record<string, string>>,
): string {
  return template.replace(CREDENTIAL_REF, (_match, field: string) => fields[field] ?? "");
}

/**
 * Resolve an AFPS 2.0 `delivery.http` declaration into a {@link HttpDeliveryPlan}.
 *
 * Returns `null` when no header can be injected (e.g. `custom` auth without an
 * explicit `delivery.http`, or a declaration with an empty header name) — the
 * MITM planner treats that as "inject nothing for this auth".
 *
 * Behaviour:
 *   - Auth-type defaults supply the header name/prefix/value template when the
 *     declaration omits them.
 *   - Explicit declaration fields always win over the defaults.
 *   - `basic` with no explicit value base64s `username:password` from the bag.
 *   - `encoding: "base64"` base64s the rendered value.
 */
export function resolveAfpsHttpDelivery(
  authType: string,
  fields: Readonly<Record<string, string>>,
  http: AfpsHttpDelivery | undefined,
): HttpDeliveryPlan | null {
  const defaults = AUTH_TYPE_DEFAULTS[authType] ?? { name: "", prefix: "", value: "" };

  const headerName = http?.name ?? defaults.name;
  if (!headerName) return null;

  const headerPrefix = http?.prefix ?? defaults.prefix;
  const valueTemplate = http?.value ?? defaults.value;

  let value = valueTemplate.length === 0 ? "" : renderCredentialTemplate(valueTemplate, fields);
  if (http?.encoding === "base64" && value.length > 0) {
    value = Buffer.from(value, "utf8").toString("base64");
  }

  // basic with no explicit value template → build base64(username:password).
  if (value.length === 0 && authType === "basic" && http?.value === undefined) {
    const username = fields["username"] ?? "";
    const password = fields["password"] ?? "";
    value = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  }

  return {
    headerName,
    headerPrefix,
    value,
    allowServerOverride: http?.allow_server_override === true,
  };
}
