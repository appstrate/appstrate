// SPDX-License-Identifier: Apache-2.0

/**
 * The account's email: changed only by the explicit button, which stays disabled until the field
 * holds another valid address, an invalid one being said under the field.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "http://localhost" },
});

const { EmailChangeField } = await import("../preferences/general.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

function field(draft: string | null): string {
  return render(
    <EmailChangeField
      email="alice@example.com"
      draft={draft}
      pending={false}
      onDraftChange={() => {}}
      onSubmit={() => {}}
    />,
  );
}

/** The submit button's opening tag. */
function button(html: string): string {
  const tag = /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0];
  if (!tag) throw new Error("no submit button");
  return tag;
}

describe("EmailChangeField", () => {
  it("shows the current address with an explicit button, disabled until something changes", () => {
    const html = field(null);
    expect(html).toContain('value="alice@example.com"');
    expect(html).toContain("Modifier l'email");
    expect(button(html)).toContain('disabled=""');
  });

  it("says an invalid address and keeps the button disabled", () => {
    const html = field("alice@");
    expect(html).toContain("Adresse email invalide");
    expect(html).toContain('aria-invalid="true"');
    expect(button(html)).toContain('disabled=""');
  });

  it("enables the button for another valid address", () => {
    const html = field("bob@example.com");
    expect(html).not.toContain("Adresse email invalide");
    expect(button(html)).not.toContain('disabled=""');
  });

  it("keeps the button disabled when the typed address is the current one", () => {
    expect(button(field(" alice@example.com "))).toContain('disabled=""');
  });
});
