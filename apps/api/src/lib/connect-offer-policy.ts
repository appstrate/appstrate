// SPDX-License-Identifier: Apache-2.0

/**
 * Request-side gate for the run-kickoff connect-offer relay (issue #1207): the
 * caller ASKED for a `connect_url` (`RUN_CONNECT_OFFERS_HEADER`, whose docblock
 * says who may), and the actor could have minted the same link by hand — it
 * holds `integrations:connect`, the permission guarding the connect routes.
 */

import type { Context } from "hono";
import { RUN_CONNECT_OFFERS_HEADER } from "@appstrate/core/run-and-wait-client";
import { callerPermissions } from "./permissions.ts";
import type { AppEnv } from "../types/index.ts";

export interface ConnectOfferPolicy {
  /** Actor holds `integrations:connect` — may be handed a connect capability. */
  canConnect: boolean;
  /** Actor holds `integrations:configure` — overrides `block_user_connections`. */
  canConfigure: boolean;
}

/**
 * Exact, not truthy: a capability-granting switch must be asked for in the
 * documented spelling, so a proxy's `0` or an echoed default cannot turn it on.
 */
const OPT_IN_VALUE = "1";

/**
 * `null` when the header is absent or carries another value — the
 * overwhelmingly common case, and the one that must cost nothing downstream.
 */
export function connectOfferPolicyFromRequest(c: Context<AppEnv>): ConnectOfferPolicy | null {
  if (c.req.header(RUN_CONNECT_OFFERS_HEADER) !== OPT_IN_VALUE) return null;
  const permissions = callerPermissions(c);
  return {
    canConnect: permissions.has("integrations:connect"),
    canConfigure: permissions.has("integrations:configure"),
  };
}
