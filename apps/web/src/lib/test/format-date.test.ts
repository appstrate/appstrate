// SPDX-License-Identifier: Apache-2.0
import { afterAll, describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n";
import { formatAge, formatRelativeTime, formatScheduledAt, formatTimeUntil } from "../format-date";

await i18nReady;

// The i18n instance is shared by every suite of the run, and they expect French.
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

// The unit ladder is core's (`packages/core/test/format.test.ts`); here, the
// binding to the interface language and what scheduling adds on top.
const NOW = Date.parse("2026-11-21T12:00:00Z");
const HOUR = 3_600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
// Intl separates with no-break spaces; the assertions are about the words.
const plain = (text: string) => text.replace(/\s/g, " ");

describe("relative dates in the interface's language", () => {
  it("follow the language the interface switches to", async () => {
    expect(plain(formatRelativeTime(at(-3 * HOUR), NOW))).toBe("il y a 3 h");
    expect(plain(formatAge(at(-3 * HOUR), NOW))).toBe("3 h");
    await i18n.changeLanguage("en");
    try {
      expect(plain(formatRelativeTime(at(-3 * HOUR), NOW, "long"))).toBe("3 hours ago");
      expect(plain(formatAge(at(-3 * HOUR), NOW))).toBe("3 hr");
    } finally {
      await i18n.changeLanguage("fr");
    }
  });
});

describe("formatTimeUntil", () => {
  it("reads a run the scheduler has not picked up yet as now, not as past", () => {
    expect(plain(formatTimeUntil(at(-2 * 60_000), NOW))).toBe("maintenant");
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
