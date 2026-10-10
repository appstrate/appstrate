// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "bun:test";
import i18n from "../../i18n.ts";
import { TimeField } from "../time-field.tsx";
import { render } from "./run-fixture.tsx";

const inLanguage = async (lng: string) => {
  await i18n.changeLanguage(lng);
  return render(<TimeField value="17:05" onChange={() => {}} />);
};
const selects = (html: string) => html.match(/role="combobox"/g)?.length ?? 0;

describe("TimeField", () => {
  const initial = i18n.language;
  afterAll(async () => {
    await i18n.changeLanguage(initial);
  });

  it("counts in 24 hours in French, whatever the browser's locale: hour and minute only", async () => {
    const html = await inLanguage("fr");
    expect(selects(html)).toBe(2);
    expect(html).not.toContain('type="time"');
  });

  it("adds the period where the language counts in 12 hours", async () => {
    const html = await inLanguage("en");
    expect(selects(html)).toBe(3);
    expect(html).toContain('aria-label="AM or PM"');
  });
});
