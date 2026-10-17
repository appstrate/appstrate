// SPDX-License-Identifier: Apache-2.0

import type { paths } from "../api/schema";

type AdminPinBody =
  paths["/api/integrations/{packageId}/pins/{agentPackageId}"]["put"]["requestBody"]["content"]["application/json"];

/** An admin pin as the pins table holds it: the set it imposes, and whether runs may add to it. */
interface AdminPinValue {
  connection_ids: string[];
  allow_additional_connections: boolean;
}

/**
 * The body of an admin pin write. The PUT replaces the whole pin, the flag included (absent is
 * `false`, whatever was stored), so it is always sent.
 */
export function adminPinBody(pin: AdminPinValue): AdminPinBody {
  return {
    connection_ids: pin.connection_ids,
    allow_additional_connections: pin.allow_additional_connections,
  };
}

/** The same pin opened to additions, or closed to them: its imposed set is rewritten as stored. */
export function toggledAdditionsBody(pin: AdminPinValue): AdminPinBody {
  return adminPinBody({ ...pin, allow_additional_connections: !pin.allow_additional_connections });
}

/** The `settings` sentence of each reason an admin pin's additions switch cannot flip. */
export const ADDITIONS_REFUSAL_KEYS = {
  inactive_agent: "integration.admin.pinManagement.additionsInactiveAgent",
  unavailable_connection: "integration.admin.pinManagement.additionsUnavailableConnection",
  no_imposed_connection: "integration.admin.pinManagement.additionsNeedConnection",
  enforced_default: "integration.admin.pinManagement.additionsEnforcedDefault",
} as const;

/**
 * Why an admin pin's additions switch cannot flip, else `null`. Either way the toggle rewrites the
 * stored set, which the server refuses (404) while the pin's agent is not active in the space
 * (`agentInactive`, the pin's own `agent_active`) and while the set names a connection no longer
 * shared into the space (`unavailableIds`, the table's « Connexion indisponible »). Opening is also
 * refused over an empty (or not yet chosen) set, which imposes nothing to add to, and while the space
 * enforces a default, which is always closed.
 */
export function additionsRefusal(
  pin: { connection_ids: readonly string[] | null; allow_additional_connections: boolean },
  context: { enforcedDefault: boolean; unavailableIds: readonly string[]; agentInactive: boolean },
): keyof typeof ADDITIONS_REFUSAL_KEYS | null {
  if (context.agentInactive) return "inactive_agent";
  if (pin.connection_ids?.some((id) => context.unavailableIds.includes(id))) {
    return "unavailable_connection";
  }
  if (pin.allow_additional_connections) return null;
  if (pin.connection_ids === null || pin.connection_ids.length === 0) {
    return "no_imposed_connection";
  }
  return context.enforcedDefault ? "enforced_default" : null;
}
