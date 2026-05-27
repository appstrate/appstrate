// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS `delivery.http` resolver (snake_case, value-template shape).
 *
 * The AFPS `auths.{key}.delivery.http` block (snake_case) is:
 *
 *   { in: "header", name }              header channel + name
 *   { prefix }                          value prefix, e.g. "Bearer "
 *   { value: "{$credential.<field>}" }  value template
 *   { value: "<template>", encoding }   base64-encoded template
 *   { allow_server_override }           strip caller override when false
 *
 * This module is a THIN ADAPTER: the AFPS snake_case → resolver-config
 * projection lives once in `@appstrate/afps-shared/delivery-http`
 * (`projectHttpDeliveryConfig`); this module just delegates to it and then to
 * the single engine {@link resolveHttpDelivery} (in `@appstrate/afps-runtime`,
 * the dependency-free bottom layer). The per-auth-type default table, the
 * `basic → base64(user:pass)` fallback, and the base64-encoding branch all live
 * in that one engine — they are NOT re-implemented here.
 */

import { projectHttpDeliveryConfig } from "@appstrate/afps-shared/delivery-http";
import { resolveHttpDelivery } from "@appstrate/afps-runtime/resolvers";
import type { HttpDeliveryPlan } from "./integration-credentials.ts";

// Preserve the historical `@appstrate/connect/afps-delivery` surface — the
// AFPS `delivery.http` block shape now lives in the shared package.
export type { AfpsHttpDelivery } from "@appstrate/afps-shared/delivery-http";
import type { AfpsHttpDelivery } from "@appstrate/afps-shared/delivery-http";

/**
 * Resolve an AFPS `delivery.http` declaration into a {@link HttpDeliveryPlan}.
 *
 * Returns `null` when no header can be injected (e.g. `custom` auth without an
 * explicit `delivery.http`, or a declaration with an empty header name) — the
 * MITM planner treats that as "inject nothing for this auth".
 *
 * All behaviour (auth-type defaults, `basic → base64(user:pass)` fallback,
 * `encoding: "base64"` per RFC 7617) is supplied by {@link resolveHttpDelivery};
 * the AFPS-block → config projection is supplied by
 * `@appstrate/afps-shared:projectHttpDeliveryConfig`. This function only glues
 * the two together.
 */
export function resolveAfpsHttpDelivery(
  authType: string,
  fields: Readonly<Record<string, string>>,
  http: AfpsHttpDelivery | undefined,
): HttpDeliveryPlan | null {
  return resolveHttpDelivery(authType, fields, projectHttpDeliveryConfig(http));
}
