// SPDX-License-Identifier: Apache-2.0

/**
 * The share dialog's pieces: the audience shows the state the package has in each target, and the
 * home-space note points to membership (team home) or to the move (personal home) — never tabs.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import type { PackageShare } from "../../../hooks/use-package-shares.ts";
import { HomeSpaceNote, ShareList } from "../share-package-dialog.tsx";

await i18nReady;

function share(name: string, enabled: boolean): PackageShare {
  return {
    object: "package_share",
    target: { kind: "space", spaceId: `spc_${name}`, name },
    shared_by: null,
    enabled,
    createdAt: "2026-10-17T10:00:00.000Z",
  };
}

describe("ShareList", () => {
  it("badges each target with the state of the package there", () => {
    const html = render(
      <ShareList
        shares={[share("Marketing", true), share("Ventes", false)]}
        isLoading={false}
        onRevoke={() => {}}
      />,
    );
    expect(html).toContain("Marketing");
    expect(html).toContain("Actif");
    expect(html).toContain("Ventes");
    expect(html).toContain("Désactivé");
  });

  it("says so when nothing is shared", () => {
    const html = render(<ShareList shares={[]} isLoading={false} onRevoke={() => {}} />);
    expect(html).toContain("n'est partagé avec personne");
    expect(html).not.toContain("Actif");
  });
});

describe("withdrawing a share", () => {
  it("names a person's target as their personal space in the confirmation", () => {
    const label = i18n.t("settings:catalogue.personalSpaceOf", { name: "Alice" });
    expect(i18n.t("settings:catalogue.revokeTitle", { space: label })).toBe(
      "Retirer de l'espace personnel de Alice ?",
    );
  });
});

describe("HomeSpaceNote", () => {
  it("offers the move, and no members link, for a personal home", () => {
    const html = render(
      <HomeSpaceNote personal onMoveHome={() => {}} onManageMembers={() => {}} />,
    );
    expect(html).toContain("Déplacer vers un espace d'équipe");
    expect(html).not.toContain("/workspace-settings/members");
  });

  it("links to the home space's members for a team home, with no move button", () => {
    const html = render(
      <HomeSpaceNote personal={false} onMoveHome={() => {}} onManageMembers={() => {}} />,
    );
    expect(html).toContain("Gérer les membres de l'espace d'origine");
    expect(html).toContain('href="/workspace-settings/members"');
    expect(html).not.toContain("Déplacer vers un espace d'équipe");
  });

  it("withholds the link from a caller who cannot enter the home space", () => {
    const html = render(<HomeSpaceNote personal={false} />);
    expect(html).not.toContain("/workspace-settings/members");
  });
});
