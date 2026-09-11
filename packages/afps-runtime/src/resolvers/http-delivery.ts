// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 Appstrate

/**
 * Canonical `delivery.http` credential-injection resolver, shared by the
 * platform (`@appstrate/connect` re-exports these) and the portable
 * `appstrate run` CLI ({@link ./integration-api-call.ts}).
 *
 * afps-runtime is the dependency-free bottom layer, so the single copy lives
 * here. `@appstrate/connect`'s `afps-delivery.ts` is a thin adapter that maps
 * the AFPS snake_case `delivery.http` block onto {@link HttpDeliveryConfig}
 * and delegates to {@link resolveHttpDelivery} — the per-auth-type default
 * table, the `basic` fallback, and the base64 branch are NOT duplicated there.
 *
 * The resolver is credential-source agnostic: it takes the auth type, the
 * decrypted credential fields, and the manifest's `delivery.http` block, and
 * returns the header name + rendered value the proxy injects (or `null` when
 * nothing should be injected).
 */

import { substituteVars } from "./template-vars.ts";

// The resolver config shape lives once in the zero-dep `@appstrate/afps-shared`
// (the canonical `delivery.http` projection target). Re-export it here so
// consumers importing from `@appstrate/afps-runtime/resolvers` keep their path.
export type { HttpDeliveryConfig } from "@appstrate/afps-shared/delivery-http";
import type { HttpDeliveryConfig } from "@appstrate/afps-shared/delivery-http";

/**
 * Plan returned by {@link resolveHttpDelivery}. The proxy uses this to decide
 * whether to inject a header and what value to set; `allowServerOverride`
 * mirrors the manifest setting (default `false` → the proxy strips any
 * caller-supplied header of the same name before injection).
 */
export interface HttpDeliveryPlan {
  headerName: string;
  headerPrefix: string;
  /** Rendered, post-encoding value ready to be sent as the header value. */
  value: string;
  /** Mirrors manifest; default `false` means the proxy MUST strip caller overrides. */
  allowServerOverride: boolean;
}

/**
 * Credential-header decision shared by every HTTP delivery topology.
 *
 * `caller_override` is distinct from `none`: callers use it to preserve the
 * manifest-authorised header while avoiding a refresh / reconnection verdict
 * for a 401 that did not use the platform credential.
 */
export type HttpDeliveryInjectionDecision =
  | { kind: "none" }
  | { kind: "caller_override"; headerName: string }
  | { kind: "inject"; header: { name: string; value: string } };

/**
 * Plan the observable credential-header mutation for one outgoing request.
 *
 * This is the single rendering + override-policy seam for remote MCP, MITM,
 * credential-proxy, and portable `api_call` callers. It never inspects or
 * normalises `plan.value`: a valid secret whose bytes happen to start with an
 * auth-scheme word must reach the upstream unchanged (#988).
 *
 * AFPS §7.6 defines `prefix` as a literal prepended to the rendered value, so
 * it is concatenated verbatim — an `Authorization` scheme carries its own
 * separator (`"Bearer "`, `"Basic "`), exactly like a composite prefix
 * (`"Token token="`) or a cookie one (`"session="`). A bare scheme is a defect
 * in whatever authored it, and each of the two authoring surfaces refuses it
 * up front through the one shared predicate
 * (`@appstrate/afps-shared/delivery-http:isBareAuthSchemePrefix`): a manifest
 * at install time (`@appstrate/core/integration`), a local creds file when it
 * is read ({@link ./integration-api-call.ts}). Nothing repairs it here.
 */
export function planHttpDeliveryInjection(
  plan: Pick<HttpDeliveryPlan, "headerName" | "headerPrefix" | "value" | "allowServerOverride">,
  callerHeaderNames: readonly string[],
): HttpDeliveryInjectionDecision {
  if (plan.headerName.length === 0) return { kind: "none" };

  const callerSetHeader = callerHeaderNames.some(
    (name) => name.toLowerCase() === plan.headerName.toLowerCase(),
  );
  if (plan.allowServerOverride && callerSetHeader) {
    return { kind: "caller_override", headerName: plan.headerName };
  }
  if (plan.value.length === 0) return { kind: "none" };

  return {
    kind: "inject",
    header: {
      name: plan.headerName,
      value: `${plan.headerPrefix}${plan.value}`,
    },
  };
}

/**
 * Auth-type defaults for `delivery.http`. `valueFrom` names the credential
 * field to inject, using the **canonical snake_case storage keys** — the same
 * convention the OAuth2 strategy persists (`access_token`) and the AFPS spec
 * documents (`{{api_key}}`). Manifest `valueFrom` / template `{{var}}` refs
 * must match the stored field name exactly; there is no casing aliasing.
 *
 * Source: AFPS spec §4.1.3 (fields exposed implicitly by auth type).
 */
const AUTH_TYPE_HTTP_DEFAULTS: Readonly<
  Record<string, { headerName: string; headerPrefix: string; valueFrom: string }>
> = {
  oauth2: { headerName: "Authorization", headerPrefix: "Bearer ", valueFrom: "access_token" },
  api_key: { headerName: "X-Api-Key", headerPrefix: "", valueFrom: "api_key" },
  basic: { headerName: "Authorization", headerPrefix: "Basic ", valueFrom: "" },
  custom: { headerName: "", headerPrefix: "", valueFrom: "" },
};

function renderTemplate(
  template: string,
  fields: Readonly<Record<string, string>>,
  encoding: "base64" | undefined,
): string {
  const rendered = substituteVars(template, fields);
  if (encoding === "base64") return Buffer.from(rendered, "utf8").toString("base64");
  return rendered;
}

/**
 * Resolve a `delivery.http` plan for a single auth. Returns `null` when no
 * header can be injected (e.g. `custom` auth without explicit `delivery.http`)
 * — callers treat that as "the proxy injects nothing for this auth".
 *
 * Defaults are derived from the auth type per AFPS spec §4.1.4 — `oauth2` sends
 * `Authorization: Bearer <access_token>`, `api_key` sends `X-Api-Key: <api_key>`,
 * etc. Explicit manifest values always win.
 */
export function resolveHttpDelivery(
  authType: string,
  fields: Readonly<Record<string, string>>,
  http: HttpDeliveryConfig | undefined,
): HttpDeliveryPlan | null {
  const defaults = AUTH_TYPE_HTTP_DEFAULTS[authType] ?? {
    headerName: "",
    headerPrefix: "",
    valueFrom: "",
  };
  const headerName = http?.headerName ?? defaults.headerName;
  if (!headerName) return null;

  const headerPrefix = http?.headerPrefix ?? defaults.headerPrefix;

  let value: string;
  const valueFrom = http?.valueFrom ?? defaults.valueFrom;
  if (typeof valueFrom === "string") {
    // basic / custom with no explicit valueFrom — value is empty; the proxy
    // builds the value itself (e.g. basic auth base64s username:password).
    value = valueFrom.length === 0 ? "" : (fields[valueFrom] ?? "");
  } else {
    value = renderTemplate(valueFrom.template, fields, valueFrom.encoding);
  }

  if (value.length === 0 && authType === "basic" && !http?.valueFrom) {
    const username = fields["username"] ?? "";
    const password = fields["password"] ?? "";
    value = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  }

  return {
    headerName,
    headerPrefix,
    value,
    allowServerOverride: http?.allowServerOverride === true,
  };
}
