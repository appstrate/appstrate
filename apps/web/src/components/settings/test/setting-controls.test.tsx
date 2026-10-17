// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { InlineTextSetting } from "../inline-text-setting.tsx";
import { SettingRow } from "../setting-row.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("InlineTextSetting", () => {
  const html = render(<InlineTextSetting value="Acme" maxLength={100} onCommit={async () => {}} />);

  it("starts clean without a save bar", () => {
    expect(html).not.toContain("Modifications non enregistrées");
  });

  it("takes the server's length limit", () => {
    expect(html).toContain('maxLength="100"');
  });
});

describe("SettingRow", () => {
  it("hands its label's id to a control the label does not name by itself", () => {
    const html = render(
      <SettingRow label="Thème">{(labelId) => <button aria-labelledby={labelId} />}</SettingRow>,
    );
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(new RegExp(`id="${labelledBy}"[^>]*>Thème<`).test(html)).toBe(true);
  });
});
