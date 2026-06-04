// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS `delivery.http` block → resolver-config projection — the SINGLE
 * source of truth, used by both `@appstrate/connect`'s `afps-delivery.ts`
 * and `@appstrate/afps-runtime`'s `resolvers/integration-api-call.ts`.
 *
 * The AFPS `auths.{key}.delivery.http` block (snake_case) is:
 *
 *   { in: "header", name }              header channel + name
 *   { prefix }                          value prefix, e.g. "Bearer "
 *   { value: "{$credential.<field>}" }  value template
 *   { value: "<template>", encoding }   base64-encoded template
 *   { allow_server_override }           strip caller override when false
 *
 * The value is a TEMPLATE referencing credential fields via the
 * `{$credential.<field>}` syntax. This module is a pure shape projection: it
 * maps the AFPS snake_case block onto the resolver `HttpDeliveryConfig` shape
 * (lowering `{$credential.<field>}` references to the resolver's
 * `valueFrom` field name / `{{field}}` template syntax). The per-auth-type
 * default table, the `basic → base64(user:pass)` fallback, and the base64
 * encoding branch all live in the resolver engine
 * (`@appstrate/afps-runtime/resolvers:resolveHttpDelivery`) — they are NOT
 * re-implemented here.
 */

/**
 * Resolver config consumed by `resolveHttpDelivery`
 * (`@appstrate/afps-runtime/resolvers`). This zero-dep package is the single
 * source of truth for the shape; afps-runtime re-exports it.
 */
export interface HttpDeliveryConfig {
  headerName?: string;
  headerPrefix?: string;
  valueFrom?: string | { template: string; encoding?: "base64" };
  allowServerOverride?: boolean;
}

/**
 * Subset of the AFPS `auths.{key}.delivery.http` block (snake_case). `value`
 * is a template; `{$credential.<field>}` references resolve against the auth's
 * credential bag.
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

/** A single `{$credential.<field>}` reference spanning the whole string. */
const SINGLE_CREDENTIAL_REF = /^\{\$credential\.([A-Za-z0-9_]+)\}$/;

/**
 * Project an AFPS `delivery.http` block (snake_case) onto the resolver's
 * {@link HttpDeliveryConfig}. A single `{$credential.<field>}` value (with no
 * encoding) lowers to the bare `valueFrom` field name; anything richer is
 * rewritten to the resolver's `{{field}}` template syntax. Both forms resolve
 * the SAME credential bag with the same "missing field → empty" policy through
 * `resolveHttpDelivery`, so the projection is semantics-preserving.
 *
 * Returns `undefined` when no `delivery.http` block is declared, so the
 * resolver applies its own per-auth-type defaults.
 */
export function projectHttpDeliveryConfig(
  http: AfpsHttpDelivery | undefined,
): HttpDeliveryConfig | undefined {
  if (!http) return undefined;
  const cfg: HttpDeliveryConfig = {};
  if (typeof http.name === "string") cfg.headerName = http.name;
  if (typeof http.prefix === "string") cfg.headerPrefix = http.prefix;
  if (typeof http.allow_server_override === "boolean") {
    cfg.allowServerOverride = http.allow_server_override;
  }
  const value = typeof http.value === "string" ? http.value : undefined;
  if (value !== undefined) {
    const single = value.match(SINGLE_CREDENTIAL_REF);
    if (single && http.encoding === undefined) {
      cfg.valueFrom = single[1]!;
    } else {
      const template = value.replace(
        /\{\$credential\.([A-Za-z0-9_]+)\}/g,
        (_m, field: string) => `{{${field}}}`,
      );
      cfg.valueFrom = http.encoding === "base64" ? { template, encoding: "base64" } : { template };
    }
  }
  return cfg;
}
