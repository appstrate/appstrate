// SPDX-License-Identifier: Apache-2.0

/**
 * When a schedule fires, composed as a phrase instead of typed as cron (rhythm, time,
 * zone, raw expression for anything else). Seeded by the expression (`parseCron`); reports
 * `null` while the raw expression is invalid.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, FieldDescription, FieldGroup } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { OptionSelect } from "@/components/app-ui/option-select";
import { ToggleGroup, ToggleGroupItem } from "@appstrate/ui/components/toggle-group";
import {
  type Frequency,
  type FrequencyKind,
  type TimeOfDay,
  HOUR_STEPS,
  MINUTE_STEPS,
  WEEK_ORDER,
  cronFires,
  parseCron,
  toCron,
} from "../lib/cron-frequency";
import { frequencyFormats } from "../lib/frequency-summary";
import { TimezoneSelect } from "./timezone-select";

/** The rhythms offered, in the order of the select, with their labels. */
const KIND_LABELS: Record<FrequencyKind, string> = {
  minutes: "schedule.frequency.kind.minutes",
  hours: "schedule.frequency.kind.hours",
  daily: "schedule.frequency.kind.daily",
  weekly: "schedule.frequency.kind.weekly",
  monthly: "schedule.frequency.kind.monthly",
  custom: "schedule.cronLabel",
};
const UNIT_LABELS = {
  minutes: "schedule.frequency.unit.minutes",
  hours: "schedule.frequency.unit.hours",
} as const;
const NINE: TimeOfDay = { hour: 9, minute: 0 };

/** The shape a rhythm opens with, keeping the time already chosen. */
function switchKind(from: Frequency, kind: FrequencyKind): Frequency {
  const at = "at" in from ? from.at : NINE;
  switch (kind) {
    case "minutes":
      return { kind, every: 15 };
    case "hours":
      return { kind, every: 1, minute: 0 };
    case "daily":
      return { kind, at };
    case "weekly":
      return { kind, days: [1], at };
    case "monthly":
      return { kind, day: 1, at };
    case "custom":
      return { kind, cron: toCron(from) };
  }
}

/** `09:30` ↔ the time input; a cleared or half-typed field parses to nothing and is ignored. */
const timeValue = (at: TimeOfDay) =>
  `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
function parseTime(value: string): TimeOfDay | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);

export function FrequencyComposer({
  cron,
  timezone,
  onChange,
  onTimezoneChange,
}: {
  cron: string;
  timezone: string;
  onChange: (cron: string | null) => void;
  onTimezoneChange: (timezone: string) => void;
}) {
  const { t, i18n } = useTranslation(["agents"]);
  const format = frequencyFormats(i18n.language);
  const [frequency, setFrequency] = useState<Frequency>(() => parseCron(cron));

  // Only a composition the scheduler would accept is reported.
  const update = (next: Frequency) => {
    setFrequency(next);
    const nextCron = toCron(next);
    onChange(cronFires(nextCron, timezone) ? nextCron : null);
  };
  const setAt = (value: string) => {
    const at = parseTime(value);
    if (at && "at" in frequency) update({ ...frequency, at });
  };

  return (
    <FieldGroup className="gap-5">
      <Field>
        <Label htmlFor="frequency-kind">{t("schedule.frequency.repeat")}</Label>
        <OptionSelect
          id="frequency-kind"
          value={frequency.kind}
          onValueChange={(kind) => update(switchKind(frequency, kind as FrequencyKind))}
          options={Object.entries(KIND_LABELS).map(([kind, label]) => ({
            value: kind,
            label: t(label),
          }))}
        />
      </Field>

      {(frequency.kind === "minutes" || frequency.kind === "hours") && (
        <Field>
          <Label htmlFor="frequency-every">{t("schedule.frequency.every")}</Label>
          <div className="flex items-center gap-2">
            <OptionSelect
              id="frequency-every"
              className="w-24"
              value={String(frequency.every)}
              onValueChange={(value) => update({ ...frequency, every: Number(value) })}
              options={(frequency.kind === "minutes" ? MINUTE_STEPS : HOUR_STEPS).map((every) => ({
                value: String(every),
                label: every,
              }))}
            />
            <span className="text-muted-foreground text-sm">{t(UNIT_LABELS[frequency.kind])}</span>
          </div>
        </Field>
      )}

      {frequency.kind === "hours" && (
        <Field>
          <Label htmlFor="frequency-minute">{t("schedule.frequency.atMinute")}</Label>
          <OptionSelect
            id="frequency-minute"
            className="w-24"
            value={String(frequency.minute)}
            onValueChange={(minute) => update({ ...frequency, minute: Number(minute) })}
            options={MINUTES.map((minute) => ({
              value: String(minute),
              label: String(minute).padStart(2, "0"),
            }))}
          />
        </Field>
      )}

      {frequency.kind === "weekly" && (
        <Field>
          <Label id="frequency-days">{t("schedule.frequency.days")}</Label>
          <ToggleGroup
            type="multiple"
            aria-labelledby="frequency-days"
            variant="outline"
            className="flex-wrap justify-start"
            value={frequency.days.map(String)}
            // At least one day stays ticked: a week with no day is no rhythm.
            onValueChange={(values) =>
              values.length > 0 && update({ ...frequency, days: values.map(Number) })
            }
          >
            {WEEK_ORDER.map((day) => (
              <ToggleGroupItem
                key={day}
                value={String(day)}
                aria-label={format.weekday(day, "long")}
                className="min-w-14"
              >
                {format.weekday(day, "short")}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      )}

      {frequency.kind === "monthly" && (
        <Field>
          <Label htmlFor="frequency-day">{t("schedule.frequency.dayOfMonth")}</Label>
          <OptionSelect
            id="frequency-day"
            className="w-24"
            value={String(frequency.day)}
            onValueChange={(day) => update({ ...frequency, day: Number(day) })}
            options={DAYS_OF_MONTH.map((day) => ({ value: String(day), label: day }))}
          />
          {frequency.day > 28 && (
            <FieldDescription>{t("schedule.frequency.dayOfMonthHint")}</FieldDescription>
          )}
        </Field>
      )}

      {"at" in frequency && (
        <Field>
          <Label htmlFor="frequency-at">{t("schedule.frequency.at")}</Label>
          <div>
            <Input
              id="frequency-at"
              type="time"
              className="w-32"
              value={timeValue(frequency.at)}
              onChange={(e) => setAt(e.target.value)}
            />
          </div>
        </Field>
      )}

      {frequency.kind === "custom" && (
        <Field>
          <Label htmlFor="frequency-cron">{t("schedule.cronLabel")}</Label>
          <Input
            id="frequency-cron"
            className="font-mono"
            value={frequency.cron}
            placeholder="0 9 * * 1-5"
            aria-invalid={!cronFires(frequency.cron, timezone) || undefined}
            onChange={(e) => update({ kind: "custom", cron: e.target.value })}
          />
          <FieldDescription>{t("schedule.cronHint")}</FieldDescription>
        </Field>
      )}

      <Field>
        <Label htmlFor="frequency-timezone">{t("schedule.timezone")}</Label>
        <TimezoneSelect id="frequency-timezone" value={timezone} onChange={onTimezoneChange} />
      </Field>
    </FieldGroup>
  );
}
