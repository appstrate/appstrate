// SPDX-License-Identifier: Apache-2.0

/**
 * A custom role holding a permission the platform can no longer name — its
 * module was unloaded — must stay legible AND editable: the server reports the
 * two halves separately (`permissions` / `unavailable_permissions`), so the
 * editor names the unavailable half instead of re-deriving it from the picker,
 * and never puts it in the selection a save resends. The Studio is a checkbox of its own
 * (`shows_studio`), outside the permission picker.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { ShowsStudioField, UnavailablePermissions } from "../org-settings/roles.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("the unavailable group", () => {
  it("names each permission and says what saving does to it", () => {
    const html = render(<UnavailablePermissions permissions={["chat:write"]} />);
    expect(html).toContain("Indisponible");
    expect(html).toContain("chat:write");
    expect(html).toContain("enregistrer le rôle les supprime");
  });

  it("renders nothing when the role holds no unknown permission", () => {
    expect(render(<UnavailablePermissions permissions={[]} />)).toBe("");
  });
});

describe("the Studio checkbox", () => {
  it("is its own field, labelled as display only, and reflects shows_studio", () => {
    const on = render(<ShowsStudioField checked onChange={() => {}} />);
    expect(on).toContain('id="role-shows-studio"');
    expect(on).toContain("Afficher le Studio dans l’interface");
    expect(on).toContain("affichage seul");
    expect(on).toContain('data-state="checked"');
    // It is not a permission of the picker: no `studio:read` string is drawn.
    expect(on).not.toContain("studio:read");

    const off = render(<ShowsStudioField checked={false} onChange={() => {}} />);
    expect(off).toContain('data-state="unchecked"');
  });
});
