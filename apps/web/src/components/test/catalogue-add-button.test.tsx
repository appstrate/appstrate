// SPDX-License-Identifier: Apache-2.0

/**
 * The Découvrir card's slot: with a working space it adds there in one click or says « Ajouté »;
 * in « Tous les espaces » it names the space, opens the menu of spaces, and counts where the
 * package already runs.
 *
 * Static markup: a click cannot be dispatched and a closed Radix menu renders no entries, so what
 * a click adds, and which spaces the menu offers or ticks, is driven in the browser
 * (`e2e/tests/spaces/catalogue-add.ui.spec.ts`). Here: which control the slot draws.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { AddableSpace } from "../catalogue-add-button.tsx";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { CatalogueAddButton } = await import("../catalogue-add-button.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;
const commonFr = (await import("../../locales/fr/common.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const space = (id: string, name: string, active: boolean): AddableSpace => ({
  id,
  name,
  personal: false,
  icon: null,
  color: null,
  active,
});

const slot = (spaces: AddableSpace[], workingSpaceId: string | null, busy = false) =>
  render(
    <CatalogueAddButton
      spaces={spaces}
      workingSpaceId={workingSpaceId}
      busy={busy}
      onAdd={() => {}}
    />,
  );

const add = commonFr["btn.add"];
const added = settingsFr["catalogue.added"];
const addedIn = (count: number) =>
  settingsFr[count === 1 ? "catalogue.addedIn_one" : "catalogue.addedIn_other"].replace(
    "{{count}}",
    String(count),
  );

describe("with a working space", () => {
  it("draws one plain « Ajouter » button, naming no space and opening no menu", () => {
    const html = slot([space("spc_a", "Alpha", false), space("spc_b", "Beta", true)], "spc_a");
    expect(html).toContain(`</svg>${add}</button>`);
    expect([...html.matchAll(/<button/g)]).toHaveLength(1);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("Alpha");
    // Beta runs it, but the working space is the context: nothing counts elsewhere.
    expect(html).not.toContain("title=");
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).not.toContain(added);
  });

  it("holds the button while an add is in flight", () => {
    const html = slot([space("spc_a", "Alpha", false)], "spc_a", true);
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });

  it("says « Ajouté » where it runs, as a state and not a control", () => {
    const html = slot([space("spc_a", "Alpha", true), space("spc_b", "Beta", false)], "spc_a");
    expect(html).toContain(`</svg>${added}</div>`);
    expect(html).not.toContain("<button");
  });

  it("draws nothing where the reader may not add it", () => {
    expect(slot([space("spc_b", "Beta", false)], "spc_a")).toBe("");
  });
});

describe("in « Tous les espaces »", () => {
  it("names the one space it may be added to, on a plain button", () => {
    const html = slot([space("spc_a", "Alpha", false)], null);
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*>[\\s\\S]*${settingsFr["catalogue.addTo"].replace("{{space}}", "Alpha")}`,
      ),
    );
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  it("opens the menu of spaces and counts those it already runs in", () => {
    const html = slot(
      [space("spc_a", "Alpha", true), space("spc_b", "Beta", true), space("spc_c", "Gamma", false)],
      null,
    );
    // One trigger, and no space named on it: the spaces are the menu's.
    expect([...html.matchAll(/<button/g)]).toHaveLength(1);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toMatch(/Alpha|Beta|Gamma/);
    expect(html).toContain(`title="${addedIn(2)}"`);
    expect(html).toContain(`<span class="sr-only">${addedIn(2)}</span>`);
  });

  it("opens the menu without a count when it runs nowhere yet", () => {
    const html = slot([space("spc_a", "Alpha", false), space("spc_b", "Beta", false)], null);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain("title=");
  });

  it("says in how many spaces it is added when nothing is left to add", () => {
    const html = slot([space("spc_a", "Alpha", true), space("spc_b", "Beta", true)], null);
    expect(html).toContain(addedIn(2));
    expect(html).not.toContain("<button");
    expect(slot([space("spc_a", "Alpha", true)], null)).toContain(addedIn(1));
  });

  it("draws nothing where it runs nowhere and cannot be added", () => {
    expect(slot([], null)).toBe("");
  });
});
