// SPDX-License-Identifier: Apache-2.0

/**
 * The integration index: the server's ACTIVE set of this space, split by execution, the rest left
 * to the space library, and a page menu only for a caller with a deed in it.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import { packageKeys } from "../../lib/query-keys.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

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
): IntegrationIndexItem {
  return {
    id,
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
    server: sourceKind === "local" ? { name: `${id}-server`, version: "^1.0.0" } : null,
  };
}

function page(permissions: string[], integrations: IntegrationIndexItem[]): string {
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
  // The index of this space, as the server answers it: the active set only.
  qc.setQueryData(packageKeys.list("integrations", null, SPACE_ID), integrations);
  const snapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<IntegrationsPage />, { queryClient: qc });
  } finally {
    snapshot.mockRestore();
  }
}

const READER = ["spaces:read", "integrations:read"];

describe("the integration index", () => {
  it("draws the server's index, the remote tab without the local integrations", () => {
    const html = page(READER, [
      integration("@acme/remote", "Zéphyr"),
      integration("@acme/api", "Boréal", "none"),
      integration("@acme/local", "Kestrel", "local"),
    ]);
    expect(html).toContain("Zéphyr");
    expect(html).toContain("Boréal");
    expect(html).not.toContain("Kestrel");
  });

  it("heads a connections column, and says « — » while the account list is unknown", () => {
    const html = page(READER, [integration("@acme/remote", "Zéphyr")]);
    expect(html).toContain(settingsFr["integrations.col.connections"]);
    expect(html).toContain("—");
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
