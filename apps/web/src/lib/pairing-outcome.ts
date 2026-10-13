// SPDX-License-Identifier: Apache-2.0

import type { paths } from "../api/client";

type PairingStatus =
  paths["/api/model-providers-oauth/pairing/{id}"]["get"]["responses"][200]["content"]["application/json"];

/**
 * How long a consumed pairing may stay without a credential before it counts as
 * refused. The redeem links the credential in the request that consumes the
 * pairing, so a few poll cycles cover it.
 */
export const PAIRING_LINK_WAIT_MS = 10_000;

export type PairingOutcome = "waiting" | "connected" | "failed" | "expired";

/**
 * What a pairing poll means. The redeem consumes the pairing before it judges and
 * writes: success is the credential, not `consumed`. A consumed pairing with no
 * credential is the redeem in flight, then, once `linkWaitElapsed`
 * (`PAIRING_LINK_WAIT_MS` spent in that state), a refused one.
 */
export function pairingOutcome(
  poll: Pick<PairingStatus, "status" | "credentialId"> | undefined,
  linkWaitElapsed: boolean,
): PairingOutcome {
  if (!poll || poll.status === "pending") return "waiting";
  if (poll.status === "expired") return "expired";
  if (poll.credentialId) return "connected";
  return linkWaitElapsed ? "failed" : "waiting";
}
