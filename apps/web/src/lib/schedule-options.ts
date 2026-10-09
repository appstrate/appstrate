// SPDX-License-Identifier: Apache-2.0

/** The schedule's Paramètres tab: its sections, their URLs, the inherit sentinel. */

import {
  BrainCircuit,
  CalendarClock,
  IdCard,
  Plug,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";

// Sentinel for the schedule's "inherit" version choice — nothing stored; the
// agent's version resolution applies at fire time, which means the latest
// published version.
export const VERSION_INHERIT = "__inherit__";

export const SCHEDULE_SETTINGS_SECTIONS = [
  {
    id: "general",
    icon: IdCard,
    labelKey: "schedule.settings.general",
    descriptionKey: "schedule.settings.generalDescription",
  },
  {
    id: "recurrence",
    icon: CalendarClock,
    labelKey: "schedule.settings.recurrence",
    descriptionKey: "schedule.settings.recurrenceDescription",
  },
  {
    id: "identity",
    icon: UserRound,
    labelKey: "schedule.settings.identity",
    descriptionKey: "schedule.settings.identityDescription",
  },
  {
    id: "inputs",
    icon: SlidersHorizontal,
    labelKey: "schedule.settings.inputs",
    descriptionKey: "schedule.settings.inputsDescription",
  },
  {
    id: "execution",
    icon: BrainCircuit,
    labelKey: "schedule.settings.execution",
    descriptionKey: "schedule.settings.executionDescription",
  },
  {
    id: "connections",
    icon: Plug,
    labelKey: "schedule.settings.connections",
    descriptionKey: "schedule.settings.connectionsDescription",
  },
] as const;

export type ScheduleSettingsSection = (typeof SCHEDULE_SETTINGS_SECTIONS)[number]["id"];

/** The URL of one section of a schedule's Paramètres tab. */
export function scheduleSettingsHref(scheduleId: string, section: ScheduleSettingsSection) {
  return `/schedules/${scheduleId}?scheduleSettings=${section}#settings`;
}
