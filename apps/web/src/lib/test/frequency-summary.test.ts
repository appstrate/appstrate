// SPDX-License-Identifier: Apache-2.0

/**
 * Every list says a schedule with the composer's own sentence, and names the
 * zone its times are in: the expression alone (« 0 3 * * * ») said neither.
 */

import { afterAll, describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n";
import { describeFrequency, describeSchedule } from "../frequency-summary";

await i18nReady;

afterAll(async () => {
  await i18n.changeLanguage("fr");
});

describe("describeSchedule", () => {
  it("says a composed expression as the Récurrence section does, with its zone", async () => {
    await i18n.changeLanguage("fr");
    expect(describeSchedule({ cron_expression: "0 3 * * *", timezone: "UTC" })).toEqual({
      text: "Tous les jours à 3:00 (UTC)",
      isCron: false,
    });
    expect(
      describeSchedule({ cron_expression: "30 9 * * 1-5", timezone: "Europe/Paris" }).text,
    ).toBe("Chaque lundi, mardi, mercredi, jeudi et vendredi à 9:30 (Europe/Paris)");
  });

  it("keeps an expression with no sentence as itself", async () => {
    await i18n.changeLanguage("fr");
    expect(describeSchedule({ cron_expression: "0 9-17 * * *", timezone: "UTC" })).toEqual({
      text: "0 9-17 * * * (UTC)",
      isCron: true,
    });
  });

  it("follows the interface language", async () => {
    await i18n.changeLanguage("en");
    expect(describeFrequency({ kind: "daily", at: { hour: 15, minute: 0 } })).toBe(
      "Every day at 3:00 PM",
    );
  });
});
