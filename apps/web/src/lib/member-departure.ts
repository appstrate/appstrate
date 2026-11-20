// SPDX-License-Identifier: Apache-2.0

import type { operations } from "../api/schema";
import { linkedSpacePath } from "./across-spaces";
import { scheduleSettingsHref, type ScheduleSettingsSection } from "./schedule-options";

export type DepartureImpactItem =
  operations["getMemberDepartureImpact"]["responses"][200]["content"]["application/json"]["data"][number];

/**
 * The schedule settings section that fixes an item: a connection the departing member owns needs
 * a replacement, a connection they merely shared needs another choice; only a schedule that runs
 * as the member and names none of theirs is fixed by naming another actor.
 */
export function departureFixSection(
  item: Pick<DepartureImpactItem, "cause" | "lost_integrations">,
): Extract<ScheduleSettingsSection, "identity" | "connections"> {
  if (item.lost_integrations.length > 0 || item.cause === "connection_unshared") {
    return "connections";
  }
  return "identity";
}

/** Where the admin fixes an item: its schedule's settings, entering the schedule's space when it is another one. */
export function departureFixHref(
  item: Pick<DepartureImpactItem, "id" | "cause" | "lost_integrations" | "space">,
  currentSpaceId: string | null,
): string {
  return linkedSpacePath(
    scheduleSettingsHref(item.id, departureFixSection(item)),
    item.space.id,
    currentSpaceId,
  );
}
