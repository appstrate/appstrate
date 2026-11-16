// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces of a package in a list: its home first with the others counted when spanning, a
 * muted label when no home is visible, and the « Partagé depuis » cue in a single-space list.
 */

import { describe, expect, it, spyOn } from "bun:test";
import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { orgStore } from "../../stores/org-store.ts";
import { spaceStore } from "../../stores/space-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { PackageSharedFrom, PackageSpaces } from "../package-spaces.tsx";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

const space = (id: string, name: string): components["schemas"]["SpaceObject"] => ({
  object: "space",
  id,
  orgId: "org_1",
  name,
  icon: null,
  color: null,
  isDefault: false,
  settings: {},
  visibility: "open",
  default_role: "viewer",
  credential_proxy_open: true,
  personal: false,
  access: "member",
  role: null,
  permissions: [],
  created_by: null,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
});

/** `node` rendered with the reader standing in `spc_a`, who reaches Atelier, Studio and Coffre. */
function renderInSpaces(node: ReactElement): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: "org_1",
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: "spc_a",
  });
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } })
      .queryKey,
    {
      object: "list",
      data: [space("spc_a", "Atelier"), space("spc_b", "Studio"), space("spc_c", "Coffre")],
      hasMore: false,
    },
  );
  try {
    return render(node, { queryClient });
  } finally {
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
  }
}

describe("PackageSpaces", () => {
  it("names the home, then counts the other spaces with their names in the label", () => {
    const html = renderInSpaces(
      <PackageSpaces homeSpaceId="spc_b" spaceIds={["spc_b", "spc_a", "spc_c"]} system={false} />,
    );
    expect(html).toContain(">Studio<");
    expect(html).toContain('aria-label="Partagé avec Atelier, Coffre"');
    expect(html).toMatch(/<\/svg>2<\/span>/);
  });

  it("shows no badge when the package is active in its home only", () => {
    const html = renderInSpaces(
      <PackageSpaces homeSpaceId="spc_b" spaceIds={["spc_b"]} system={false} />,
    );
    expect(html).toContain(">Studio<");
    expect(html).not.toContain("Partagé avec");
  });

  it("labels a system package « Plateforme » and counts every space", () => {
    const html = renderInSpaces(
      <PackageSpaces homeSpaceId={null} spaceIds={["spc_a", "spc_b"]} system />,
    );
    expect(html).toContain(">Plateforme<");
    expect(html).toContain('aria-label="Disponible dans Atelier, Studio"');
    expect(html).toMatch(/<\/svg>2<\/span>/);
  });

  it("labels a withheld home « Espace non visible » and counts every space", () => {
    const html = renderInSpaces(
      <PackageSpaces homeSpaceId={null} spaceIds={["spc_c"]} system={false} />,
    );
    expect(html).toContain(">Espace non visible<");
    expect(html).toContain('aria-label="Disponible dans Coffre"');
  });
});

describe("PackageSharedFrom", () => {
  it("is an icon naming the home of another space's package as its label", () => {
    const html = renderInSpaces(<PackageSharedFrom homeSpaceId="spc_b" system={false} />);
    expect(html).toContain('aria-label="Partagé depuis Studio"');
  });

  it("stays generic when the home is withheld", () => {
    const html = renderInSpaces(<PackageSharedFrom homeSpaceId={null} system={false} />);
    expect(html).toContain('aria-label="Partagé depuis un autre espace"');
  });

  it.each([
    ["at home", "spc_a", false],
    ["a system package", "spc_b", true],
    ["a row off an index", undefined, false],
  ] as const)("shows nothing for %s", (_label, home, system) => {
    expect(renderInSpaces(<PackageSharedFrom homeSpaceId={home} system={system} />)).toBe("");
  });
});
