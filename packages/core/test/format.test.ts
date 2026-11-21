// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { formatAge, formatBytes, formatDuration, formatRelativeTime } from "../src/format.ts";

describe("formatDuration", () => {
  it("renders sub-second values as rounded milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(8)).toBe("8ms");
    expect(formatDuration(999.6)).toBe("1000ms");
  });

  it("renders under a minute as one-decimal seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(2657)).toBe("2.7s");
    expect(formatDuration(59_900)).toBe("59.9s");
  });

  it("renders a minute or more as <m>m <s>s", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("clamps non-finite / negative to 0ms", () => {
    expect(formatDuration(-500)).toBe("0ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
  });
});

describe("formatBytes", () => {
  it("keeps the English form when no locale is given", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(5.2 * 1024 * 1024)).toBe("5.2 MB");
    expect(formatBytes(100 * 1024 ** 3)).toBe("100 GB");
    expect(formatBytes(4096 * 1024 ** 3)).toBe("4096 GB");
  });

  it("falls back to a raw count for a malformed input", () => {
    expect(formatBytes(-1)).toBe("-1 B");
    expect(formatBytes(Number.NaN)).toBe("NaN B");
  });

  it("counts in octets with a decimal comma in French", () => {
    expect(formatBytes(512, "fr")).toBe("512 o");
    expect(formatBytes(2048, "fr")).toBe("2,0 Ko");
    expect(formatBytes(1024 * 1024, "fr-FR")).toBe("1,0 Mo");
    expect(formatBytes(12 * 1024 ** 3, "fr")).toBe("12 Go");
  });

  it("keeps the English units for another locale", () => {
    expect(formatBytes(2048, "en")).toBe("2.0 KB");
  });

  it("renders the English form for a malformed locale tag instead of throwing", () => {
    expect(formatBytes(2048, "fr_FR")).toBe("2.0 KB");
    expect(formatBytes(512, "fr_FR")).toBe("512 B");
    expect(formatBytes(2048, "")).toBe("2.0 KB");
  });
});

describe("formatRelativeTime / formatAge", () => {
  const NOW = Date.parse("2026-10-15T12:00:00Z");
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  // Intl separates with no-break spaces; the assertions are about the words.
  const plain = (text: string) => text.replace(/\s/g, " ");
  const rel = (offset: number, locale = "fr") =>
    plain(formatRelativeTime(NOW + offset, NOW, locale));
  const age = (offset: number) => plain(formatAge(NOW + offset, NOW, "fr"));

  it("reads under a minute as now, in both directions", () => {
    expect(rel(59_000)).toBe("maintenant");
    expect(rel(-59_000)).toBe("maintenant");
    expect(age(-59_000)).toBe("maintenant");
  });

  it("truncates toward zero, so nothing is announced later than it is", () => {
    expect(rel(119 * MIN)).toBe("dans 1 h");
    expect(rel(59 * MIN)).toBe("dans 59 min");
    expect(rel(-90 * MIN)).toBe("il y a 1 h");
  });

  it("counts days as 24-hour spans, never as « demain »", () => {
    expect(rel(25 * HOUR)).toBe("dans 1 j");
    expect(rel(29 * DAY)).toBe("dans 29 j");
    expect(rel(45 * DAY)).toBe("dans 1 m.");
    expect(rel(400 * DAY)).toBe("dans 1 a");
  });

  it("renders an age as a bare quantity, the same units without « il y a »", () => {
    expect(age(-5 * MIN)).toBe("5 min");
    expect(age(-3 * DAY)).toBe("3 j");
    expect(age(-800 * DAY)).toBe("2 ans");
  });

  it("renders nothing for an unparseable date, never « maintenant » or a throw", () => {
    expect(formatRelativeTime(Number.NaN, NOW, "fr")).toBe("");
    expect(formatAge(Date.parse("not a date"), NOW, "fr")).toBe("");
  });

  it("speaks the locale it is given, English when it is absent or malformed", () => {
    expect(rel(3 * HOUR, "en")).toBe("in 3 hr.");
    expect(plain(formatRelativeTime(NOW + 3 * HOUR, NOW, "en", "long"))).toBe("in 3 hours");
    expect(plain(formatRelativeTime(NOW + 3 * HOUR, NOW))).toBe("in 3 hr.");
    expect(rel(3 * HOUR, "fr_FR")).toBe("in 3 hr.");
  });
});
