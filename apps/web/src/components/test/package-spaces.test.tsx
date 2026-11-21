// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces of a package in a list or a detail header: its home first with the others counted,
 * a muted label when the home is withheld, the first active space leading when the home is off
 * or the package is a system one.
 * The header's meta line names the home only where no tile does.
 */

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { memberSpaceClient, renderInSpace, testSpace } from "../../test/space-context.ts";
import { PackageSpaces } from "../package-spaces.tsx";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

/** `node` rendered with the reader standing in Atelier, who reaches Atelier, Studio and Coffre. */
const renderInSpaces = (node: ReactElement, overview = false) =>
  renderInSpace(node, {
    overview,
    queryClient: memberSpaceClient(["spc_a", "spc_b", "spc_c"].map((id) => testSpace(id, []))),
  });

describe("PackageSpaces", () => {
  it("names the home, then counts the other spaces with their names in the label", () => {
    const html = renderInSpaces(
      <PackageSpaces item={{ homeSpaceId: "spc_b", spaceIds: ["spc_b", "spc_a", "spc_c"] }} />,
    );
    expect(html).toContain(">Studio<");
    expect(html).toContain('aria-label="Actif aussi dans Atelier, Coffre"');
    expect(html).toMatch(/>\+2<\/span>/);
  });

  it("shows no badge when the package is active in its home only", () => {
    const html = renderInSpaces(
      <PackageSpaces item={{ homeSpaceId: "spc_b", spaceIds: ["spc_b"] }} />,
    );
    expect(html).toContain(">Studio<");
    expect(html).not.toContain("Actif aussi dans");
  });

  it("draws no tile for a home it is switched off in: its first active space leads", () => {
    const html = renderInSpaces(
      <PackageSpaces item={{ homeSpaceId: "spc_b", spaceIds: ["spc_a", "spc_c"] }} />,
    );
    expect(html).not.toContain(">Studio<");
    expect(html).toContain(">Atelier<");
    expect(html).toContain('aria-label="Disponible dans Coffre"');
    expect(html).not.toContain("Espace non visible");
  });

  it("leads a system package with its first active space and counts the others", () => {
    const html = renderInSpaces(
      <PackageSpaces
        item={{ homeSpaceId: null, spaceIds: ["spc_a", "spc_b"], source: "system" }}
      />,
    );
    expect(html).toContain(">Atelier<");
    expect(html).toContain('aria-label="Disponible dans Studio"');
    expect(html).toMatch(/>\+1<\/span>/);
    expect(html).not.toContain("Plateforme");
  });

  it("draws nothing for a system package active in no space", () => {
    const html = renderInSpaces(
      <PackageSpaces item={{ homeSpaceId: null, spaceIds: [], source: "system" }} />,
    );
    expect(html).toBe("");
  });

  it("labels a withheld home « Espace non visible » and counts every space", () => {
    const html = renderInSpaces(
      <PackageSpaces item={{ homeSpaceId: null, spaceIds: ["spc_c"] }} />,
    );
    expect(html).toContain(">Espace non visible<");
    expect(html).toContain('aria-label="Disponible dans Coffre"');
  });

  it("names a detail's spaces the same way in both modes, the home first and the others stacked", () => {
    const detail = { homeSpaceId: "spc_b", spaceIds: ["spc_b", "spc_a"], source: "local" };
    for (const overview of [false, true]) {
      const html = renderInSpaces(<PackageSpaces item={detail} />, overview);
      expect(html).toContain(">Studio<");
      expect(html).toContain('data-testid="space-tile-stack"');
      expect(html).toContain('aria-label="Actif aussi dans Atelier"');
      // Named as a space, never as « Espace d'origine ».
      expect(html).not.toContain("origine");
    }
  });
});
