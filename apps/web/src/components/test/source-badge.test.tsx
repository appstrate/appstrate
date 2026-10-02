// SPDX-License-Identifier: Apache-2.0

/**
 * `SourceBadge` reads two vocabularies: the provenance of models, credentials
 * and proxies (`built-in` / `custom`) and the owning tier of an integration
 * OAuth client (`system` / `org` / `space`). Rendered with
 * `renderToStaticMarkup` (the web runner has no DOM), asserted on the label.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n, { i18nReady } from "../../i18n.ts";
import { SourceBadge } from "../source-badge.tsx";

await i18nReady;
await i18n.changeLanguage("en");

const label = (element: Parameters<typeof SourceBadge>[0]) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SourceBadge {...element} />
    </I18nextProvider>,
  ).replace(/<[^>]+>/g, "");

describe("SourceBadge", () => {
  it("names an OAuth client's tier", () => {
    expect(label({ source: "system" })).toBe(i18n.t("source.builtIn", { ns: "settings" }));
    expect(label({ source: "org" })).toBe(i18n.t("source.org", { ns: "settings" }));
    expect(label({ source: "space" })).toBe(i18n.t("source.space", { ns: "settings" }));
    expect(label({ source: "space", autoProvisioned: true })).toBe(
      i18n.t("source.autoProvisioned", { ns: "settings" }),
    );
  });

  it("keeps the provenance labels of the other tables", () => {
    expect(label({ source: "built-in" })).toBe(i18n.t("source.builtIn", { ns: "settings" }));
    expect(label({ source: "custom" })).toBe(i18n.t("source.custom", { ns: "settings" }));
  });
});
