// SPDX-License-Identifier: Apache-2.0

/**
 * The integration index: the ACTIVE set of this space, the rest left to the space library, and a
 * page menu only for a caller with a deed in it.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { IntegrationSummaryWire } from "../../hooks/use-integrations.ts";

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

function integration(id: string, name: string, active: boolean): IntegrationSummaryWire {
  return {
    id,
    source: "local",
    active,
    orgId: "org_a",
    manifest: {
      name: id,
      type: "integration",
      version: "1.0.0",
      display_name: name,
      source: {
        kind: "remote",
        remote: { url: "https://example.test/mcp", transport: "streamable-http" },
      },
      auths: {},
    },
  };
}

function page(permissions: string[], integrations: IntegrationSummaryWire[]): string {
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
  qc.setQueryData(
    [
      "get",
      "/api/integrations",
      {
        params: {
          query: { limit: 100, offset: 0 },
          header: { "X-Org-Id": undefined, "X-Space-Id": SPACE_ID },
        },
      },
    ],
    integrations,
  );
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
  it("lists the integrations active here, not one switched off or merely offered", () => {
    const html = page(READER, [
      integration("@acme/on", "Allumée", true),
      integration("@acme/off", "Éteinte", false),
    ]);
    expect(html).toContain("Allumée");
    expect(html).not.toContain("Éteinte");
  });

  it("points at the space library when nothing is active here", () => {
    const html = page(READER, [integration("@acme/off", "Éteinte", false)]);
    expect(html).toContain(settingsFr["integrations.empty.space"]);
    expect(html).toMatch(/href="\/catalogue\/[^"]*integration[^"]*"/);
  });

  it("gives a reader no page menu, and a caller with a deed one", () => {
    expect(page(READER, [])).not.toContain("data-page-actions-trigger");
    expect(page([...READER, "integrations:write"], [])).toContain("data-page-actions-trigger");
  });
});
