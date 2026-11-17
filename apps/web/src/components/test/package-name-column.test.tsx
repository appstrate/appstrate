// SPDX-License-Identifier: Apache-2.0

/** The package name cell keeps one second line: the description, else the identifier. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { CardItem } from "../../lib/package-card-item.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { usePackageNameColumn } = await import("../package-columns.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const item = (description?: string | null): CardItem => ({
  id: "@appstrate/agent-test",
  displayName: "Agent test",
  description,
  type: "agent",
});

function NameCell({ item }: { item: CardItem }) {
  return usePackageNameColumn().cell(item);
}

describe("the package name column", () => {
  it("shows the description, not the identifier, when there is one", () => {
    const html = render(<NameCell item={item("Trie le courrier")} />);
    expect(html).toContain("Trie le courrier");
    expect(html).not.toContain("@appstrate/agent-test");
  });

  it.each([null, "", undefined])("falls back to the identifier when description is %p", (d) => {
    const html = render(<NameCell item={item(d)} />);
    expect(html).toMatch(/class="[^"]*font-mono[^"]*"[^>]*>@appstrate\/agent-test</);
    expect(html).toContain('title="@appstrate/agent-test"');
  });

  it("does not print the identifier twice when the name already is the identifier", () => {
    const html = render(
      <NameCell item={{ ...item(null), displayName: "@appstrate/agent-test" }} />,
    );
    expect(html.split(">@appstrate/agent-test<")).toHaveLength(2);
    expect(html).toContain("—");
  });
});
