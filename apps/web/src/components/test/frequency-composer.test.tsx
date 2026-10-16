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
  it("keeps the cron's hour and minute in a labelled native time field", () => {
    const html = compose("5 17 * * *");
    expect(html).toContain('type="time"');
    expect(html).toMatch(/id="frequency-at"[^>]*value="17:05"/);
    expect(html).toContain('for="frequency-at"');
  });
  it("names the weekday group by its label", () => {
    const html = compose("0 9 * * 1,3");
    expect(html).toMatch(/id="frequency-days"/);
    expect(html).toMatch(/role="toolbar"[^>]*aria-labelledby="frequency-days"/);
  });

  it("shows the composed number in a controlled field", () => {
    const html = compose("0 9 15 * *");
    expect(html).toMatch(/id="frequency-day"[^>]*value="15"|value="15"[^>]*id="frequency-day"/);
    expect(html).not.toContain('aria-invalid="true"');
  });
});
