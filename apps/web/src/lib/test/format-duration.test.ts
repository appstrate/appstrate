// SPDX-License-Identifier: Apache-2.0
import { afterAll, describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n";
import { formatDuration } from "../format-duration";

await i18nReady;

// The i18n instance is shared by every suite of the run, and they expect French.
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

// Intl separates a value from its unit with a (narrow) no-break space.
const plain = (s: string) => s.replace(/\u00a0|\u202f/g, " ");

describe("formatDuration", () => {
  it("writes each range the French way", async () => {
    await i18n.changeLanguage("fr");
    expect(plain(formatDuration(842))).toBe("842 ms");
    expect(plain(formatDuration(4_800))).toBe("4,8 s");
    expect(plain(formatDuration(312_000))).toBe("5 min 12 s");
  });

  it("follows the interface language", async () => {
    await i18n.changeLanguage("en");
    expect(plain(formatDuration(4_800))).toBe("4.8 sec");
  });

  it("reads a malformed duration as zero", async () => {
    await i18n.changeLanguage("fr");
    expect(plain(formatDuration(-5))).toBe("0 ms");
    expect(plain(formatDuration(Number.NaN))).toBe("0 ms");
  });
});
