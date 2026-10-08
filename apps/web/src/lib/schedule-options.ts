// SPDX-License-Identifier: Apache-2.0

/** What the schedule create form and the schedule's Paramètres tab share. */

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

/** The frequency shortcuts, shared with the schedule's Récurrence settings. */
export const CRON_PRESETS = [
  { labelKey: "schedule.preset30min", cron: "*/30 * * * *" },
  { labelKey: "schedule.presetHourly", cron: "0 * * * *" },
  { labelKey: "schedule.presetDaily9", cron: "0 9 * * *" },
  { labelKey: "schedule.presetWeekday9", cron: "0 9 * * 1-5" },
  { labelKey: "schedule.presetMonday9", cron: "0 9 * * 1" },
] as const;

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
