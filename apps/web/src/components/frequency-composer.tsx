// SPDX-License-Identifier: Apache-2.0

/**
 * When a schedule fires, composed as a phrase instead of typed as cron: a
 * rhythm (every N minutes or hours, every day, some weekdays, a day of the
 * month), its time, its zone, and the raw expression for anything else. What
 * was composed is always read back: a sentence and the next three fires,
 * computed by the parser the scheduler itself uses.
 *
 * Seeded by the expression: one the composer can say reopens as its phrase,
 * any other one as itself (`parseCron`). It reports `null` while what is
 * composed is incomplete or invalid (a week with no day, a bad expression).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, FieldDescription, FieldGroup } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@appstrate/ui/components/toggle-group";
import {
  type Frequency,
  type FrequencyKind,
  type TimeOfDay,
  WEEK_ORDER,
  nextFires,
  parseCron,
  toCron,
} from "../lib/cron-frequency";
import { TimezoneSelect } from "./timezone-select";

/** The rhythms offered, in the order of the select, with their labels. */
const KIND_LABELS: Record<FrequencyKind, string> = {
  minutes: "schedule.frequency.kind.minutes",
  hours: "schedule.frequency.kind.hours",
  daily: "schedule.frequency.kind.daily",
  weekly: "schedule.frequency.kind.weekly",
  monthly: "schedule.frequency.kind.monthly",
  custom: "schedule.frequency.kind.custom",
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

function isComplete(frequency: Frequency): boolean {
  return frequency.kind !== "weekly" || frequency.days.length > 0;
}

/** `09:30` ↔ the native time input. */
const timeValue = (at: TimeOfDay) =>
  `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
function parseTime(value: string): TimeOfDay | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** A whole number within bounds, or null while the field is being typed. */
function bounded(value: string, min: number, max: number): number | null {
  const n = Number(value);
  return value !== "" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function useFormats(timezone: string) {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const time = (at: TimeOfDay) =>
    new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
      Date.UTC(2000, 0, 1, at.hour, at.minute),
    );
  // 7 January 2024 was a Sunday: cron weekday d is that date plus d days.
  const weekday = (day: number, width: "long" | "short") =>
    new Intl.DateTimeFormat(lang, { weekday: width, timeZone: "UTC" }).format(
      Date.UTC(2024, 0, 7 + day),
    );
  // `Intl.ListFormat` is ES2021; the app's TS lib stops at ES2020.
  const ListFormat = (
    Intl as unknown as {
      ListFormat: new (lang: string, opts: object) => { format: (items: string[]) => string };
    }
  ).ListFormat;
  const list = (items: string[]) =>
    new ListFormat(lang, { style: "long", type: "conjunction" }).format(items);
  const fire = (date: Date) =>
    new Intl.DateTimeFormat(lang, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(date);
  return { time, weekday, list, fire };
}

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
  const { t } = useTranslation(["agents"]);
  const format = useFormats(timezone);
  const [frequency, setFrequency] = useState<Frequency>(() => parseCron(cron));

  const expression = toCron(frequency);
  const fires = isComplete(frequency) ? nextFires(expression, timezone) : null;
  const update = (next: Frequency) => {
    setFrequency(next);
    const nextCron = toCron(next);
    onChange(isComplete(next) && nextFires(nextCron, timezone, 1) ? nextCron : null);
  };
  const setAt = (value: string) => {
    const at = parseTime(value);
    if (at && "at" in frequency) update({ ...frequency, at });
  };

  const summary = (() => {
    switch (frequency.kind) {
      case "minutes":
        return t("schedule.frequency.summary.minutes", { count: frequency.every });
      case "hours":
        return t("schedule.frequency.summary.hours", {
          count: frequency.every,
          minute: String(frequency.minute).padStart(2, "0"),
        });
      case "daily":
        return t("schedule.frequency.summary.daily", { time: format.time(frequency.at) });
      case "weekly":
        return frequency.days.length === 0
          ? t("schedule.frequency.noDay")
          : t("schedule.frequency.summary.weekly", {
              days: format.list(
                WEEK_ORDER.filter((d) => frequency.days.includes(d)).map((d) =>
                  format.weekday(d, "long"),
                ),
              ),
              time: format.time(frequency.at),
            });
      case "monthly":
        return t(
          frequency.day === 1
            ? "schedule.frequency.summary.monthlyFirst"
            : "schedule.frequency.summary.monthly",
          { day: frequency.day, time: format.time(frequency.at) },
        );
      case "custom":
        return fires ? t("schedule.frequency.summary.custom") : t("schedule.frequency.invalid");
    }
  })();

  return (
    <FieldGroup className="gap-5">
      <Field>
        <Label htmlFor="frequency-kind">{t("schedule.frequency.repeat")}</Label>
        <Select
          value={frequency.kind}
          onValueChange={(kind) => update(switchKind(frequency, kind as FrequencyKind))}
        >
          <SelectTrigger id="frequency-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(KIND_LABELS).map(([kind, label]) => (
              <SelectItem key={kind} value={kind}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {(frequency.kind === "minutes" || frequency.kind === "hours") && (
        <Field>
          <Label htmlFor="frequency-every">{t("schedule.frequency.every")}</Label>
          <div className="flex items-center gap-2">
            <Input
              // Minutes and hours share this field: a new rhythm, a new default.
              key={frequency.kind}
              id="frequency-every"
              type="number"
              className="w-24"
              min={1}
              max={frequency.kind === "minutes" ? 59 : 23}
              defaultValue={frequency.every}
              onChange={(e) => {
                const every = bounded(e.target.value, 1, frequency.kind === "minutes" ? 59 : 23);
                if (every !== null) update({ ...frequency, every });
              }}
            />
            <span className="text-muted-foreground text-sm">{t(UNIT_LABELS[frequency.kind])}</span>
          </div>
        </Field>
      )}

      {frequency.kind === "hours" && (
        <Field>
          <Label htmlFor="frequency-minute">{t("schedule.frequency.atMinute")}</Label>
          {/* Kept to the width of its value: a field takes the full row. */}
          <div>
            <Input
              id="frequency-minute"
              type="number"
              className="w-24"
              min={0}
              max={59}
              defaultValue={frequency.minute}
              onChange={(e) => {
                const minute = bounded(e.target.value, 0, 59);
                if (minute !== null) update({ ...frequency, minute });
              }}
            />
          </div>
        </Field>
      )}

      {frequency.kind === "weekly" && (
        <Field>
          <Label>{t("schedule.frequency.days")}</Label>
          <ToggleGroup
            type="multiple"
            variant="outline"
            className="flex-wrap justify-start"
            value={frequency.days.map(String)}
            onValueChange={(values) => update({ ...frequency, days: values.map(Number) })}
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
          <div>
            <Input
              id="frequency-day"
              type="number"
              className="w-24"
              min={1}
              max={31}
              defaultValue={frequency.day}
              onChange={(e) => {
                const day = bounded(e.target.value, 1, 31);
                if (day !== null) update({ ...frequency, day });
              }}
            />
          </div>
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
              // shadcn's date-and-time block: the native field, its clock icon hidden.
              className="w-36 appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
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
            aria-invalid={!fires || undefined}
            onChange={(e) => update({ kind: "custom", cron: e.target.value })}
          />
          <FieldDescription>{t("schedule.cronHint")}</FieldDescription>
        </Field>
      )}

      <Field>
        <Label htmlFor="frequency-timezone">{t("schedule.timezone")}</Label>
        <TimezoneSelect id="frequency-timezone" value={timezone} onChange={onTimezoneChange} />
      </Field>

      {/* What was composed, read back. */}
      <div
        className="bg-muted/40 rounded-lg border px-4 py-3 text-sm"
        aria-live="polite"
        data-testid="frequency-summary"
      >
        <p className={fires ? "font-medium" : "text-destructive font-medium"}>{summary}</p>
        {fires && (
          <p className="text-muted-foreground mt-1 text-xs">
            {t("schedule.frequency.next")} {fires.map(format.fire).join(" · ")}
          </p>
        )}
        {frequency.kind !== "custom" && fires && (
          <p className="text-muted-foreground mt-1 font-mono text-xs">{expression}</p>
        )}
      </div>
    </FieldGroup>
  );
}
