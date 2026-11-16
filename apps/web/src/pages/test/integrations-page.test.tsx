// SPDX-License-Identifier: Apache-2.0

/**
 * The integration index: the server's ACTIVE set of this space, one list, the rest left
 * to the space library, and a page menu only for a caller with a deed in it.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import { packageKeys } from "../../lib/query-keys.ts";

// The page's creation dialog reaches the auth client, which reads the origin when it loads.
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "http://localhost:3000" },
});

const { IntegrationsPage } = await import("../integrations-page.tsx");
const { spaceStore } = await import("../../stores/space-store.ts");
const { $api } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const SPACE_ID = "spc_here";

function integration(
  id: string,
  name: string,
  sourceKind: IntegrationIndexItem["source_kind"] = "remote",
  authenticated = true,
): IntegrationIndexItem {
  return {
    id,
    spaceId: SPACE_ID,
    source: "local",
    name,
    description: null,
    icon: null,
    keywords: [],
    version: "1.0.0",
    forked_from: null,
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
    used_by_agents: 0,
    auto_installed: false,
    home_space_id: SPACE_ID,
    home_writable: false,
    home_deletable: false,
    home_shareable: false,
    source_kind: sourceKind,
    server: sourceKind === "local" ? { type: "node", entry_point: "server/index.js" } : null,
    authenticated,
  };
}

function page(
  permissions: string[],
  integrations: IntegrationIndexItem[],
  { url = "/integrations", connectionsLoaded = false } = {},
): string {
  const qc = new QueryClient();
  // No org is selected here: every scoped query is disabled and serves the cache as seeded.
  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": undefined } } })
      .queryKey,
    {
      object: "list",
      hasMore: false,
      data: [
        {
          object: "space",
          id: SPACE_ID,
          orgId: "org_a",
          name: "Ici",
          icon: null,
          color: null,
          isDefault: true,
          settings: {},
          visibility: "open",
          default_role: "viewer",
          personal: false,
          access: "member",
          role: null,
          permissions,
          created_by: null,
          createdAt: "2026-09-05T10:00:00Z",
          updatedAt: "2026-09-05T10:00:00Z",
        },
      ],
    },
  );
  // The caller's account-wide connections: none, so every count here is 0.
  if (connectionsLoaded) {
    qc.setQueryData($api.queryOptions("get", "/api/me/connections", {}).queryKey, {
      object: "list",
      hasMore: false,
      data: [],
    });
  }
  // The index of this space, as the server answers it: the active set only.
  qc.setQueryData(packageKeys.list("integrations", null, SPACE_ID), integrations);
  const snapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<IntegrationsPage />, { queryClient: qc, initialEntries: [url] });
  } finally {
    snapshot.mockRestore();
  }
}

const READER = ["spaces:read", "integrations:read"];

describe("the integration index", () => {
  const three = [
    integration("@acme/remote", "Zéphyr"),
    integration("@acme/api", "Boréal", "none"),
    integration("@acme/local", "Kestrel", "local"),
  ];

  it("draws every source in one list, without tabs", () => {
    const html = page(READER, three);
    expect(html).toContain("Zéphyr");
    expect(html).toContain("Boréal");
    expect(html).toContain("Kestrel");
    // No « Distantes / Locales » tabs: the only tablist left is the cards/table switch.
    expect(html).not.toContain("Distantes");
    expect(html).not.toContain("Locales");
    expect(html.match(/role="tablist"/g)).toHaveLength(1);
  });

  it("filters on the source param", () => {
    const html = page(READER, three, { url: "/integrations?source=none,local" });
    expect(html).not.toContain("Zéphyr");
    expect(html).toContain("Boréal");
    expect(html).toContain("Kestrel");
    const one = page(READER, three, { url: "/integrations?source=remote" });
    expect(one).toContain("Zéphyr");
    expect(one).not.toContain("Boréal");
    expect(one).not.toContain("Kestrel");
  });

  it("links each row and does not invent a connection count while it is unknown", () => {
    const html = page(READER, [integration("@acme/remote", "Zéphyr")]);
    expect(html).toContain('href="/integrations/@acme/remote"');
    expect(html).not.toContain("0 connexion");
  });

  it("counts the connections of an integration that binds them, and of no other", () => {
    const html = page(
      READER,
      [integration("@acme/remote", "Zéphyr"), integration("@acme/open", "Libre", "remote", false)],
      { connectionsLoaded: true },
    );
    expect(html).toContain("Libre");
    expect(html.match(/0 connexion/g)).toHaveLength(1);
  });

  it("points at the space library when nothing is active here", () => {
    const html = page(READER, []);
    expect(html).toContain(settingsFr["integrations.empty.space"]);
    expect(html).toMatch(/href="\/catalogue\/[^"]*integration[^"]*"/);
  });

  it("gives a reader no page menu, and a caller with a deed one", () => {
    expect(page(READER, [])).not.toContain("data-page-actions-trigger");
    expect(page([...READER, "integrations:write"], [])).toContain("data-page-actions-trigger");
  });
});
