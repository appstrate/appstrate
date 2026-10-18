// SPDX-License-Identifier: Apache-2.0

import type { paths } from "../api/schema";
import { sameSet } from "./strings";

type AdminPinBody =
  paths["/api/integrations/{packageId}/pins/{agentPackageId}"]["put"]["requestBody"]["content"]["application/json"];

/** An admin pin as the pins table holds it: the set it imposes, and whether runs may add to it. */
interface AdminPinValue {
  connection_ids: string[];
  allow_additional_connections: boolean;
}

/**
 * The two modes of an admin pin, named by their effect: runs use exactly its set (the default,
 * `allow_additional_connections: false`), or its set plus the connections the user adds (`true`).
 */
export type PinMode = "exact" | "plus";

export const PIN_MODES: readonly PinMode[] = ["exact", "plus"];

export function pinMode(pin: { allow_additional_connections: boolean }): PinMode {
  return pin.allow_additional_connections ? "plus" : "exact";
}

/** The `settings` label of each mode, and the sentence saying what it lets a run do. */
export const PIN_MODE_KEYS = {
  exact: "integration.admin.pinManagement.modeExact",
  plus: "integration.admin.pinManagement.modePlus",
} as const;
export const PIN_MODE_HELP_KEYS = {
  exact: "integration.admin.pinManagement.modeExactHelp",
  plus: "integration.admin.pinManagement.modePlusHelp",
} as const;

/** The `settings` sentence of each reason an admin pin cannot be saved in « plus ». */
export const ADDITIONS_REFUSAL_KEYS = {
  inactive_agent: "integration.admin.pinManagement.additionsInactiveAgent",
  unavailable_connection: "integration.admin.pinManagement.additionsUnavailableConnection",
  no_imposed_connection: "integration.admin.pinManagement.additionsNeedConnection",
  enforced_default: "integration.admin.pinManagement.additionsEnforcedDefault",
} as const;

/**
 * Why a pin over `pin.connection_ids` cannot be saved in « plus » (or, for the first two, at all),
 * else `null`. The server refuses (404) every write of a pin whose agent is not active in the
 * space (`agentInactive`, the pin's own `agent_active`) or whose set names a connection no longer
 * shared into the space (`unavailableIds`, the table's « Connexion indisponible »). « plus » is
 * also refused over an empty (or not yet chosen) set, which imposes nothing to add to, and while
 * the space enforces a default, which accepts only « exact ».
 */
export function additionsRefusal(
  pin: { connection_ids: readonly string[] | null },
  context: { enforcedDefault: boolean; unavailableIds: readonly string[]; agentInactive: boolean },
): keyof typeof ADDITIONS_REFUSAL_KEYS | null {
  if (context.agentInactive) return "inactive_agent";
  if (pin.connection_ids?.some((id) => context.unavailableIds.includes(id))) {
    return "unavailable_connection";
  }
  if (pin.connection_ids === null || pin.connection_ids.length === 0) {
    return "no_imposed_connection";
  }
  return context.enforcedDefault ? "enforced_default" : null;
}

/** What the pin form edits: the agent (`""` until chosen), the set, and the mode asked for. */
export interface PinDraft {
  agent: string;
  connectionIds: string[];
  chosenMode: PinMode;
}

/**
 * A new pin starts with no agent, no connection and « exact »; an edited one with its own, a
 * member no longer shared included: unticking it is how such a pin is fixed.
 */
export function initialPinDraft(
  pin: (AdminPinValue & { agent_package_id: string }) | null,
): PinDraft {
  return {
    agent: pin?.agent_package_id ?? "",
    connectionIds: pin ? [...pin.connection_ids] : [],
    chosenMode: pin ? pinMode(pin) : "exact",
  };
}

/** The `settings` sentence saying what saving a pin does to others, when it does anything. */
export const PIN_SAVE_CONSEQUENCE_KEYS = {
  clears_choices: "integration.admin.pinManagement.clearsMemberChoices",
  clears_choices_and_schedules: "integration.admin.pinManagement.clearsMemberChoicesAndSchedules",
} as const;

/**
 * The pin form's verdict on a draft (`stored` is `null` for a new pin). A draft the server would
 * refuse whatever its mode (inactive agent, unavailable member) keeps the mode chosen for display
 * and announces nothing; a « plus » refused for another reason reads « exact », whatever was
 * chosen before. An unchanged pin, or a blocked one, has nothing to save. The consequence follows
 * the server: a NEW pin saved in « exact » deletes the members' own choices for the agent (a
 * member pin never survives under it); going from « plus » to « exact » does too and also
 * disables the schedules whose overrides add connections; editing an « exact » pin, or saving in
 * « plus », announces nothing.
 */
export function pinDraftVerdict(input: {
  stored: AdminPinValue | null;
  connectionIds: string[];
  chosenMode: PinMode;
  enforcedDefault: boolean;
  unavailableIds: readonly string[];
  agentInactive: boolean;
}): {
  mode: PinMode;
  refusal: keyof typeof ADDITIONS_REFUSAL_KEYS | null;
  savable: boolean;
  consequence: keyof typeof PIN_SAVE_CONSEQUENCE_KEYS | null;
  body: AdminPinBody;
} {
  const { stored, connectionIds } = input;
  const refusal = additionsRefusal({ connection_ids: connectionIds }, input);
  const blocked = refusal === "inactive_agent" || refusal === "unavailable_connection";
  const mode: PinMode = refusal === null || blocked ? input.chosenMode : "exact";
  const changed =
    stored === null || pinMode(stored) !== mode || !sameSet(stored.connection_ids, connectionIds);
  let consequence: keyof typeof PIN_SAVE_CONSEQUENCE_KEYS | null = null;
  if (changed && !blocked && mode === "exact") {
    if (stored === null) consequence = "clears_choices";
    else if (pinMode(stored) === "plus") consequence = "clears_choices_and_schedules";
  }
  return {
    mode,
    refusal,
    savable: changed && !blocked,
    consequence,
    // The PUT replaces the whole pin, the flag included (absent is « exact », whatever was stored).
    body: { connection_ids: connectionIds, allow_additional_connections: mode === "plus" },
  };
}
