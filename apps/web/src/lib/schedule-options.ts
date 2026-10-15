// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import {
  BrainCircuit,
  CalendarClock,
  IdCard,
  Plug,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { scheduleDetailPath } from "./package-paths";
import { sectionHref } from "./settings-section-href";

// Sentinel for the "inherit" version choice: nothing stored, the latest published version applies at fire time.
export const VERSION_INHERIT = "__inherit__";

/** The version select's choices: inherit, then the working copy when `draftOffered` (non-writers would be refused at every fire, 403 `draft_not_writable`). */
export function scheduleVersionOptions(t: TFunction, { draftOffered }: { draftOffered: boolean }) {
  return [
    { value: VERSION_INHERIT, label: t("run.overrides.versionPublished", { ns: "agents" }) },
    ...(draftOffered
      ? [{ value: "draft", label: t("run.overrides.versionDraft", { ns: "agents" }) }]
      : []),
  ];
}

/** What a schedule is called wherever it is listed; a nameless one says so. */
export function scheduleLabel(schedule: Pick<ScheduleWireDto, "name">, t: TFunction): string {
  return schedule.name || t("schedule.unnamed", { ns: "agents" });
}

/** When the schedule fires next; `null` when disabled (it keeps a stale `next_run_at` in the database). */
export function scheduleNextRunAt(
  schedule: Pick<ScheduleWireDto, "enabled" | "next_run_at">,
): string | null {
  return schedule.enabled ? (schedule.next_run_at ?? null) : null;
}

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
  return sectionHref(scheduleDetailPath(scheduleId), "settings", "scheduleSettings", section);
}

/**
 * A write's state as one section says it: every section saves through one mutation,
 * so a section is quiet about writes made from another.
 */
export function sectionWriteState<
  T extends { isPending: boolean; isSuccess: boolean; isError: boolean },
>(write: T, writtenFrom: ScheduleSettingsSection | null, section: ScheduleSettingsSection): T {
  return writtenFrom === section
    ? write
    : { ...write, isPending: false, isSuccess: false, isError: false };
}
