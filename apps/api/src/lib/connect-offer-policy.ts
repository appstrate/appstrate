// SPDX-License-Identifier: Apache-2.0

/**
 * Request-side gate for the run-kickoff connect-offer relay (issue #1207).
 *
 * A `connect_url` minted into a 412 is a bearer capability that creates a
 * connection AS the calling actor: `/connect/start` is unauthenticated and acts
 * purely on the token's claims. So two things must hold before one is minted,
 * and this is where both are read off the request:
 *
 *  - the caller ASKED for it (`RUN_CONNECT_OFFERS_HEADER`) — a header no
 *    dashboard/CLI/scheduler path sets, so an ordinary 412 stays link-free;
 *  - the actor could have minted the same link by hand, i.e. it holds
 *    `integrations:connect`, the permission guarding the three connect routes
 *    in `routes/integrations.ts`.
 *
 * `canConfigure` rides along because the mint also has to honour
 * `block_user_connections`, which `integrations:configure` overrides — the same
 * carve-out `assertConnectionCreationAllowed` applies on the connect routes.
 */

import type { Context } from "hono";
import { RUN_CONNECT_OFFERS_HEADER } from "@appstrate/core/run-and-wait-client";
import type { AppEnv } from "../types/index.ts";

export interface ConnectOfferPolicy {
  /** Actor holds `integrations:connect` — may be handed a connect capability. */
  canConnect: boolean;
  /** Actor holds `integrations:configure` — overrides `block_user_connections`. */
  canConfigure: boolean;
}

/**
 * Read the caller's connect-offer policy. Returns `null` when the opt-in header
 * is absent — the overwhelmingly common case, and the one that must cost
 * nothing downstream.
 */
export function connectOfferPolicyFromRequest(c: Context<AppEnv>): ConnectOfferPolicy | null {
  if (!c.req.header(RUN_CONNECT_OFFERS_HEADER)) return null;
  const permissions = c.get("permissions");
  return {
    canConnect: permissions?.has("integrations:connect") ?? false,
    canConfigure: permissions?.has("integrations:configure") ?? false,
  };
}
