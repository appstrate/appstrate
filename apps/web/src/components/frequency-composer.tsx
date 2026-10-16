// SPDX-License-Identifier: Apache-2.0

/**
 * When a schedule fires, composed as a phrase instead of typed as cron (rhythm, time,
 * zone, raw expression for anything else) and read back as a sentence plus the next three
 * fires, from the scheduler's own parser. Seeded by the expression (`parseCron`); reports
 * `null` while the composition is incomplete or invalid.
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
  nextFires,
  parseCron,
  toCron,
} from "../lib/cron-frequency";
import { describeFrequency, frequencyFormats } from "../lib/frequency-summary";
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

function isComplete(frequency: Frequency): boolean {
  return frequency.kind !== "weekly" || frequency.days.length > 0;
}

/** `09:30` ↔ the time field. */
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

interface Bounds {
  min: number;
  max: number;
}

/** What is typed stays on screen; out of bounds it is marked and reported as `null`. */
function WholeNumberInput({
  id,
  value,
  bounds,
  onChange,
}: {
  id: string;
  value: number;
  bounds: Bounds;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(String(value));
  return (
    <Input
      id={id}
      type="number"
      className="w-24"
      min={bounds.min}
      max={bounds.max}
      value={text}
      aria-invalid={bounded(text, bounds.min, bounds.max) === null || undefined}
      onChange={(e) => {
        setText(e.target.value);
        onChange(bounded(e.target.value, bounds.min, bounds.max));
      }}
    />
  );
}

const MINUTE_BOUNDS: Bounds = { min: 0, max: 59 };
const DAY_BOUNDS: Bounds = { min: 1, max: 31 };

function useFormats(timezone: string) {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const fire = (date: Date) =>
    new Intl.DateTimeFormat(lang, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(date);
  return { ...frequencyFormats(lang), fire };
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
  // The bounds a number field is typed out of; nothing is composed meanwhile.
  const [outOfBounds, setOutOfBounds] = useState<Bounds | null>(null);

  const expression = toCron(frequency);
  const fires = isComplete(frequency) && !outOfBounds ? nextFires(expression, timezone) : null;
  const update = (next: Frequency) => {
    setFrequency(next);
    setOutOfBounds(null);
    const nextCron = toCron(next);
    onChange(isComplete(next) && nextFires(nextCron, timezone, 1) ? nextCron : null);
  };
  const updateNumber = (bounds: Bounds, value: number | null, next: (n: number) => Frequency) => {
    if (value !== null) return update(next(value));
    setOutOfBounds(bounds);
    onChange(null);
  };
  const setAt = (value: string) => {
    const at = parseTime(value);
    if (at && "at" in frequency) update({ ...frequency, at });
  };

  const summary = (() => {
    if (outOfBounds) return t("schedule.frequency.outOfBounds", { ...outOfBounds });
    if (frequency.kind === "weekly" && frequency.days.length === 0)
      return t("schedule.frequency.noDay");
    return (
      describeFrequency(frequency) ??
      (fires ? t("schedule.frequency.summary.custom") : t("schedule.frequency.invalid"))
    );
  })();

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
          {/* Kept to the width of its value: a field takes the full row. */}
          <div>
            <WholeNumberInput
              id="frequency-minute"
              value={frequency.minute}
              bounds={MINUTE_BOUNDS}
              onChange={(minute) =>
                updateNumber(MINUTE_BOUNDS, minute, (n) => ({ ...frequency, minute: n }))
              }
            />
          </div>
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
            <WholeNumberInput
              id="frequency-day"
              value={frequency.day}
              bounds={DAY_BOUNDS}
              onChange={(day) => updateNumber(DAY_BOUNDS, day, (n) => ({ ...frequency, day: n }))}
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
              required
              value={timeValue(frequency.at)}
              onChange={(event) => setAt(event.target.value)}
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
