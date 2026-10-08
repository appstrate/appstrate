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
 * table and the base64 branch are NOT duplicated there.
 *
 * The resolver is credential-source agnostic: it takes the auth type, the
 * decrypted credential fields, and the manifest's `delivery.http` block, and
 * returns the header name + rendered value the proxy injects (or `null` when
 * nothing should be injected).
 */

import { renderCredentialTemplate } from "@appstrate/afps-shared/credential-template";

// The resolver config shape lives once in the zero-internal-dependency `@appstrate/afps-shared`
// (the canonical `delivery.http` projection target). Re-export it here so
// consumers importing from `@appstrate/afps-runtime/resolvers` keep their path.
export type { HttpDeliveryConfig } from "@appstrate/afps-shared/delivery-http";
import {
  AUTH_TYPE_HTTP_DEFAULTS,
  type HttpDeliveryConfig,
} from "@appstrate/afps-shared/delivery-http";

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
 * Resolve a `delivery.http` plan for a single auth. Returns `null` when no
 * header can be injected (e.g. `custom` auth without explicit `delivery.http`)
 * — callers treat that as "the proxy injects nothing for this auth".
 *
 * Defaults are derived from the auth type per AFPS spec §4.1.4 — `oauth2` sends
 * `Authorization: Bearer <access_token>`, `api_key` sends `X-Api-Key: <api_key>`,
 * `basic` sends `Authorization: Basic base64(username:password)`. Explicit
 * manifest values always win. `variables` are the connection's (AFPS §7.12),
 * rendered for `{$variable.<name>}`.
 */
export function resolveHttpDelivery(
  authType: string,
  fields: Readonly<Record<string, string>>,
  http: HttpDeliveryConfig | undefined,
  variables: Readonly<Record<string, string>> = {},
): HttpDeliveryPlan | null {
  const defaults = AUTH_TYPE_HTTP_DEFAULTS[authType];
  const headerName = http?.headerName ?? defaults?.headerName ?? "";
  if (!headerName) return null;

  const valueFrom = http?.valueFrom ?? defaults?.valueFrom;
  let value = valueFrom ? renderCredentialTemplate(valueFrom.template, fields, { variables }) : "";
  if (valueFrom?.encoding === "base64") value = Buffer.from(value, "utf8").toString("base64");

  return {
    headerName,
    headerPrefix: http?.headerPrefix ?? defaults?.headerPrefix ?? "",
    value,
    allowServerOverride: http?.allowServerOverride === true,
  };
}
