// SPDX-License-Identifier: Apache-2.0

/** « Dans quel espace ? »: one button per eligible space, named as the switcher names it. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ location: { origin: "http://localhost" } });

const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { SpacePickerList } = await import("../space-picker-modal.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const space = (id: string, name: string, personal = false) => ({
  id,
  name,
  personal,
  icon: null,
  color: null,
  orphaned_at: null,
});

describe("SpacePickerList", () => {
  it("offers each space it is given, a personal one under the reader's own label", () => {
    const html = render(
      <SpacePickerList
        spaces={[space("spc_a", "Studio"), space("spc_me", "ignored", true)]}
        onPick={() => {}}
      />,
    );
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain("Studio");
    expect(html).toContain(i18n.t("spaces.personal.title", { ns: "settings" }));
    expect(html).not.toContain("ignored");
  });
});
