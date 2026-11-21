// SPDX-License-Identifier: Apache-2.0
import { afterAll, describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n";
import { formatRelativeDate, formatScheduledAt, formatTimeUntil } from "../format-date";

await i18nReady;

// The i18n instance is shared by every suite of the run, and they expect French.
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

const NOW = Date.parse("2026-11-21T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (offset: number) => new Date(NOW + offset).toISOString();
// Intl separates with no-break spaces; the assertions are about the words.
const plain = (text: string) => text.replace(/\s/g, " ");

describe("formatRelativeDate", () => {
  it("reads under a minute as now, in both directions", () => {
    expect(plain(formatRelativeDate(at(59_000), NOW))).toBe("maintenant");
    expect(plain(formatRelativeDate(at(-59_000), NOW))).toBe("maintenant");
  });

  it("truncates toward zero, so a run is never announced later than it is", () => {
    expect(plain(formatRelativeDate(at(119 * MIN), NOW))).toBe("dans 1 h");
    expect(plain(formatRelativeDate(at(59 * MIN), NOW))).toBe("dans 59 min");
    expect(plain(formatRelativeDate(at(-90 * MIN), NOW))).toBe("il y a 1 h");
  });

  it("counts days as 24-hour spans, never as « demain »", () => {
    expect(plain(formatRelativeDate(at(25 * HOUR), NOW))).toBe("dans 1 j");
    expect(plain(formatRelativeDate(at(29 * DAY), NOW))).toBe("dans 29 j");
    expect(plain(formatRelativeDate(at(45 * DAY), NOW))).toBe("dans 1 m.");
    expect(plain(formatRelativeDate(at(400 * DAY), NOW))).toBe("dans 1 a");
  });

  it("speaks the interface language", async () => {
    await i18n.changeLanguage("en");
    expect(plain(formatRelativeDate(at(3 * HOUR), NOW))).toBe("in 3 hr.");
    await i18n.changeLanguage("fr");
  });

  it("answers a dash for an unparseable date", () => {
    expect(plain(formatRelativeDate("not a date", NOW))).toBe("—");
  });
});

describe("formatTimeUntil", () => {
  it("reads a run the scheduler has not picked up yet as now, not as past", () => {
    expect(plain(formatTimeUntil(at(-2 * MIN), NOW))).toBe("maintenant");
    expect(plain(formatTimeUntil(at(3 * HOUR), NOW))).toBe("dans 3 h");
  });
});

describe("formatScheduledAt", () => {
  it("puts how soon before the date, named in the schedule's zone", () => {
    expect(plain(formatScheduledAt(at(3 * HOUR), "UTC", NOW))).toBe(
      "dans 3 h · 21/11/2026 15:00 UTC",
    );
  });
});
