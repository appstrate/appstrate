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
 * The body of an admin pin write. The PUT replaces the whole pin, the flag included (absent is
 * `false`, whatever was stored), so it is always sent.
 */
export function adminPinBody(pin: AdminPinValue): AdminPinBody {
  return {
    connection_ids: pin.connection_ids,
    allow_additional_connections: pin.allow_additional_connections,
  };
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
 * Why an admin pin cannot be saved in « plus » (or, for the first two, at all), else `null`. The
 * server refuses (404) every write of a pin whose agent is not active in the space
 * (`agentInactive`, the pin's own `agent_active`) or whose set names a connection no longer shared
 * into the space (`unavailableIds`, the table's « Connexion indisponible »). « plus » is also
 * refused over an empty (or not yet chosen) set, which imposes nothing to add to, and while the
 * space enforces a default, which accepts only « exact ».
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
 * The pin form's verdict on a draft (`stored` is `null` for a new pin). « plus » unavailable reads
 * « exact », whatever was chosen before; an unchanged pin, or one the server would refuse whatever
 * its mode, has nothing to save. Saving deletes the members' own choices for the agent whenever
 * the saved or the stored pin is « exact » (a member pin never survives under it), and going from
 * « plus » to « exact » also disables the schedules whose overrides add connections.
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
  const refusal = additionsRefusal(
    { connection_ids: connectionIds, allow_additional_connections: false },
    input,
  );
  const mode: PinMode = refusal === null ? input.chosenMode : "exact";
  const changed =
    stored === null || pinMode(stored) !== mode || !sameSet(stored.connection_ids, connectionIds);
  const blocked = refusal === "inactive_agent" || refusal === "unavailable_connection";
  const storedMode = stored ? pinMode(stored) : null;
  const consequence = !changed
    ? null
    : storedMode === "plus" && mode === "exact"
      ? "clears_choices_and_schedules"
      : mode === "exact" || storedMode === "exact"
        ? "clears_choices"
        : null;
  return {
    mode,
    refusal,
    savable: changed && !blocked,
    consequence,
    body: adminPinBody({
      connection_ids: connectionIds,
      allow_additional_connections: mode === "plus",
    }),
  };
}
