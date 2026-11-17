// SPDX-License-Identifier: Apache-2.0

/** The « Partagé depuis » cue of a package listed in a space that is not its home. */

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { renderInSpace } from "../../test/space-context.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { PackageSharedFrom } from "../package-shared-from.tsx";

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
  permissions: ["runs:read"],
  created_by: null,
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
});

/**
 * `node` rendered with the reader standing in `spc_a`, who reaches Atelier, Studio and Coffre;
 * `overview`: with « Tous les espaces » chosen (offered: the spaces read runs).
 */
function renderInSpaces(node: ReactElement, overview = false): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } })
      .queryKey,
    {
      object: "list",
      data: [space("spc_a", "Atelier"), space("spc_b", "Studio"), space("spc_c", "Coffre")],
      hasMore: false,
    },
  );
  return renderInSpace(node, { overview, queryClient });
}

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

  it("shows nothing in « Tous les espaces », where the Space column names the spaces", () => {
    const shared = <PackageSharedFrom homeSpaceId="spc_b" system={false} />;
    expect(renderInSpaces(shared, true)).toBe("");
    expect(renderInSpaces(shared)).toContain("Partagé depuis Studio");
  });
});
