// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";

/**
 * A time of day (`"HH:mm"`), written in the clock of the APP's language, not of
 * the browser's: the native `<input type="time">` follows the browser locale, so
 * a French interface could show « 09:30 AM ». Hour and minute are selects; the
 * period is a third one only where the language counts in 12 hours.
 */
const pad = (n: number) => String(n).padStart(2, "0");
const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);
const HOURS_12 = [12, ...Array.from({ length: 11 }, (_, i) => i + 1)];
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

/** The localized « AM » / « PM » (12-hour languages only). */
function periodLabel(lang: string, hour: number) {
  return (
    new Intl.DateTimeFormat(lang, { hour: "numeric", hour12: true, timeZone: "UTC" })
      .formatToParts(Date.UTC(2000, 0, 1, hour))
      .find((part) => part.type === "dayPeriod")?.value ?? (hour < 12 ? "AM" : "PM")
  );
}

export function TimeField({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation("common");
  const lang = i18n.language;
  const hour12 = new Intl.DateTimeFormat(lang, { hour: "numeric" }).resolvedOptions().hour12;
  const [h, m] = value.split(":").map(Number);
  const hour = h !== undefined && Number.isInteger(h) ? h : 0;
  const minute = m !== undefined && Number.isInteger(m) ? m : 0;
  const pm = hour >= 12;
  const emit = (nextHour: number, nextMinute: number) =>
    onChange(`${pad(nextHour)}:${pad(nextMinute)}`);

  return (
    <div className="flex items-center gap-1.5" role="group">
      <Select
        value={String(hour12 ? hour % 12 : hour)}
        onValueChange={(v) => emit(hour12 ? (Number(v) % 12) + (pm ? 12 : 0) : Number(v), minute)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-[4.5rem]" aria-label={t("timeField.hour")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(hour12 ? HOURS_12 : HOURS_24).map((v) => (
            <SelectItem key={v} value={String(hour12 ? v % 12 : v)}>
              {hour12 ? v : pad(v)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span aria-hidden>:</span>
      <Select
        value={String(minute)}
        onValueChange={(v) => emit(hour, Number(v))}
        disabled={disabled}
      >
        <SelectTrigger className="w-[4.5rem]" aria-label={t("timeField.minute")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MINUTES.map((v) => (
            <SelectItem key={v} value={String(v)}>
              {pad(v)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hour12 && (
        <Select
          value={pm ? "pm" : "am"}
          onValueChange={(v) => emit((hour % 12) + (v === "pm" ? 12 : 0), minute)}
          disabled={disabled}
        >
          <SelectTrigger className="w-20" aria-label={t("timeField.period")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="am">{periodLabel(lang, 9)}</SelectItem>
            <SelectItem value="pm">{periodLabel(lang, 15)}</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
