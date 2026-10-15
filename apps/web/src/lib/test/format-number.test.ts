// SPDX-License-Identifier: Apache-2.0
import { afterAll, describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n";
import { formatNumber } from "../format-number";

await i18nReady;

// The i18n instance is shared by every suite of the run, and they expect French.
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

describe("formatNumber", () => {
  it("groups digits the way the interface language does", async () => {
    await i18n.changeLanguage("en");
    expect(formatNumber(1234567)).toBe("1,234,567");
    await i18n.changeLanguage("fr");
    expect(formatNumber(1234567)).toBe("1 234 567");
  });
});
