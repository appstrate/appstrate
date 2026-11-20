// SPDX-License-Identifier: Apache-2.0

import type { operations } from "../api/schema";
import { linkedSpacePath } from "./across-spaces";
import { scheduleSettingsHref, type ScheduleSettingsSection } from "./schedule-options";

export type DepartureImpactItem =
  operations["getMemberDepartureImpact"]["responses"][200]["content"]["application/json"]["data"][number];

/**
 * The schedule settings section that fixes an item. A schedule that runs as the leaving member
 * changes ACTOR first, always: the connections section only lets the viewer pick their own
 * connections and resets stale picks after an actor change, so any replacement connection comes
 * as the second step. A schedule of another actor on a connection the member shared only needs
 * another connection.
 */
export function departureFixSection(
  item: Pick<DepartureImpactItem, "cause">,
): Extract<ScheduleSettingsSection, "identity" | "connections"> {
  return item.cause === "actor_left_org" ? "identity" : "connections";
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

/**
 * The removal waits for the first read of its impact so the admin never confirms blind. A failed
 * read does not block: the impact is then shown as unknown and the admin may still proceed.
 */
export function departureConfirmBlocked(impact: { isLoading: boolean; error: unknown }): boolean {
  return impact.isLoading && !impact.error;
}
