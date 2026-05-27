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
 * use). This module is a THIN ADAPTER: it maps the AFPS 2.0 snake_case shape
 * onto the runtime plan-input shape (rewriting `{$credential.<field>}` →
 * `{{field}}`, a pure syntax projection over the same credential bag) and
 * delegates to the single engine {@link resolveHttpDelivery} (in
 * `@appstrate/afps-runtime`, the dependency-free bottom layer). The
 * per-auth-type default table, the `basic → base64(user:pass)` fallback, and the
 * base64-encoding branch all live in that one engine — they are NOT
 * re-implemented here.
 */

import { resolveHttpDelivery, type HttpDeliveryConfig } from "@appstrate/afps-runtime/resolvers";
import type { HttpDeliveryPlan } from "./integration-credentials.ts";

/**
 * Rewrite the AFPS 2.0 `{$credential.<field>}` value-template syntax into the
 * `{{field}}` syntax the shared engine's `substituteVars` renders. Both resolve
 * the SAME credential bag with the same "missing field → empty" policy, so this
 * is a pure syntax projection — the substitution semantics are unchanged.
 */
function toEngineTemplate(value: string): string {
  return value.replace(/\{\$credential\.([A-Za-z0-9_]+)\}/g, "{{$1}}");
}

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

/**
 * Resolve an AFPS 2.0 `delivery.http` declaration into a {@link HttpDeliveryPlan}.
 *
 * Returns `null` when no header can be injected (e.g. `custom` auth without an
 * explicit `delivery.http`, or a declaration with an empty header name) — the
 * MITM planner treats that as "inject nothing for this auth".
 *
 * All behaviour (auth-type defaults, `basic → base64(user:pass)` fallback,
 * `encoding: "base64"` per RFC 7617 — prefix unencoded, value base64'd) is
 * supplied by {@link resolveHttpDelivery}; this function only maps the AFPS 2.0
 * snake_case block onto its plan-input shape:
 *   - `name` / `prefix` → `headerName` / `headerPrefix` (undefined → engine
 *     default for the auth type).
 *   - `value` (a `{$credential.<field>}` template) → `valueFrom.template`,
 *     carrying `encoding`. Left undefined when the manifest omits `value`, so
 *     the engine applies its own default value template + `basic` fallback.
 */
export function resolveAfpsHttpDelivery(
  authType: string,
  fields: Readonly<Record<string, string>>,
  http: AfpsHttpDelivery | undefined,
): HttpDeliveryPlan | null {
  const config: HttpDeliveryConfig = {
    headerName: http?.name,
    headerPrefix: http?.prefix,
    valueFrom:
      http?.value === undefined
        ? undefined
        : { template: toEngineTemplate(http.value), encoding: http.encoding },
    allowServerOverride: http?.allow_server_override,
  };
  return resolveHttpDelivery(authType, fields, config);
}
