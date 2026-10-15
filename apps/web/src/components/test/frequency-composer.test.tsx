// SPDX-License-Identifier: Apache-2.0

/** The rhythm composer's fields, as a screen reader and a form read them. */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { FrequencyComposer } from "../frequency-composer.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const compose = (cron: string) =>
  render(
    <FrequencyComposer
      cron={cron}
      timezone="UTC"
      onChange={() => {}}
      onTimezoneChange={() => {}}
    />,
  );

describe("FrequencyComposer", () => {
  it("names the weekday group by its label", () => {
    const html = compose("0 9 * * 1,3");
    expect(html).toMatch(/id="frequency-days"/);
    expect(html).toMatch(/role="toolbar"[^>]*aria-labelledby="frequency-days"/);
  });

  it("labels the day of the month by its field", () => {
    const html = compose("0 9 15 * *");
    expect(html).toMatch(/for="frequency-day"/);
    expect(html).toMatch(/id="frequency-day"/);
  });

  it("marks a raw expression the scheduler would refuse", () => {
    expect(compose("not cron")).toContain('aria-invalid="true"');
    expect(compose("0 9 * * 1-5")).not.toContain('aria-invalid="true"');
  });
});
