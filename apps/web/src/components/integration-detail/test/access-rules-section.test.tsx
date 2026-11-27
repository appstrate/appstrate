// SPDX-License-Identifier: Apache-2.0

/**
 * Paramètres › Gestion des connexions: who may create connections is the integration's
 * `block_user_connections` switch alone (an enforced space default does not lock it), beside the
 * space default and the per-agent exceptions.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { AccessRulesSection } = await import("../access-rules-section.tsx");
const { orgStore } = await import("../../../stores/org-store.ts");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { render } = await import("../../../test/render.tsx");
const { $api } = await import("../../../api/client.ts");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";
const INTEGRATION = "@acme/gmail";

function renderSection(blockUserConnections: boolean): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    {
      object: "list",
      data: [
        {
          object: "space",
          id: SPACE_ID,
          orgId: ORG_ID,
          name: "Default",
          icon: null,
          color: null,
          isDefault: true,
          settings: {},
          visibility: "open",
          default_role: "viewer",
          personal: false,
          access: "member",
          role: null,
          permissions: ["integrations:read", "integrations:configure"],
          created_by: null,
          createdAt: "2026-09-05T10:00:00Z",
          updatedAt: "2026-09-05T10:00:00Z",
        },
      ],
      hasMore: false,
    },
  );
  // An ENFORCED default: it governs which connections run, not who may create one.
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}/default", {
      params: {
        path: { packageId: INTEGRATION },
        header: { "X-Org-Id": ORG_ID, "X-Space-Id": SPACE_ID },
      },
    }).queryKey,
    { integration_id: INTEGRATION, connection_ids: ["conn_1"], enforce: true },
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const current = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(
      <AccessRulesSection packageId={INTEGRATION} blockUserConnections={blockUserConnections} />,
      { queryClient },
    );
  } finally {
    org.mockRestore();
    current.mockRestore();
  }
}

describe("who may create connections", () => {
  it("stays editable under an enforced space default", () => {
    for (const blocked of [false, true]) {
      const toggle = renderSection(blocked).match(
        /<button[^>]*data-testid="block-user-connections-toggle"[^>]*>/,
      )?.[0];
      expect(toggle).toBeDefined();
      expect(toggle).not.toContain(' disabled=""');
      expect(toggle).not.toContain("data-disabled");
    }
  });

  it("holds the toggle, the space default and the per-agent exceptions, in that order", () => {
    const html = renderSection(false);
    const order = [
      'data-testid="block-user-connections-section"',
      'data-testid="org-default-section"',
      'data-testid="pin-management-section"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
