// SPDX-License-Identifier: Apache-2.0

/**
 * The integration overview. Its dependents come from the package read, which
 * counts the organization's agents in every space; it names and links only the
 * ones this space lists, the others' pages answering 404 from here. Its tools
 * stat opens Paramètres › Outils at the section's own address. In « Tous les espaces » its
 * connection figures are the reader's own across the integration's spaces, as its index card counts.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { IntegrationOverview } = await import("../integration-overview.tsx");
const { orgStore } = await import("../../../stores/org-store.ts");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { authStore } = await import("../../../stores/auth-store.ts");
const { overviewStore } = await import("../../../stores/overview-store.ts");
const { agentsKeys } = await import("../../../lib/query-keys.ts");
const { render } = await import("../../../test/render.tsx");
const i18nModule = await import("../../../i18n.ts");
type IntegrationDetailWire = import("../../../hooks/use-integrations.ts").IntegrationDetailWire;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";

const DETAIL = {
  active: true,
  auths: [],
  tool_catalog: [{ name: "send" }, { name: "read" }],
} as unknown as IntegrationDetailWire;

const connection = (
  spaceId: string | null,
  needsReconnection: boolean,
  orgId = ORG_ID,
  authKey = "oauth",
) => ({
  org: { id: orgId, name: "Acme" },
  space: spaceId ? { id: spaceId, name: spaceId } : null,
  needs_reconnection: needsReconnection,
  auth_key: authKey,
});

const listedSpace = (id: string, name: string) => ({
  id,
  object: "space",
  access: "member",
  permissions: ["integrations:read"],
  personal: false,
  isDefault: id === "spc_a",
  name,
  role: null,
});

const MY_CONNECTIONS = {
  object: "list",
  hasMore: false,
  data: [
    {
      source_id: "@acme/gmail",
      connections: [
        connection("spc_b", false),
        connection(null, true),
        connection("spc_c", true),
        connection(null, false, "org_other"),
      ],
    },
    { source_id: "@acme/other", connections: [connection(null, false)] },
  ],
};

function renderOverview(
  dependentIds: string[],
  { overview = false, spaceIds }: { overview?: boolean; spaceIds?: string[] } = {},
): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["get", "/api/me/connections", {}], MY_CONNECTIONS);
  queryClient.setQueryData(["get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } }], {
    object: "list",
    hasMore: false,
    data: [listedSpace("spc_a", "Studio"), listedSpace("spc_b", "Coffre")],
  });
  queryClient.setQueryData(agentsKeys.list(ORG_ID, SPACE_ID), [
    { id: "@acme/here", display_name: "Ici" },
    { id: "@acme/unrelated", display_name: "Sans rapport" },
  ]);
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  const auth = spyOn(authStore, "getInitialState").mockReturnValue({
    ...authStore.getInitialState(),
    user: { id: "u_1", email: "u@example.test", emailVerified: true },
  });
  const mode = spyOn(overviewStore, "getInitialState").mockReturnValue({
    ...overviewStore.getInitialState(),
    chosen: overview ? { [`u_1:${ORG_ID}`]: true } : {},
  });
  try {
    return render(
      <IntegrationOverview
        packageId="@acme/gmail"
        detail={DETAIL}
        spaceIds={spaceIds}
        dependentIds={dependentIds}
        onOpenConnections={() => {}}
      />,
      { queryClient, initialEntries: ["/integrations/@acme/gmail?other=1"] },
    );
  } finally {
    org.mockRestore();
    space.mockRestore();
    auth.mockRestore();
    mode.mockRestore();
  }
}

/** The value of the stat labelled `label`. */
function statValue(html: string, label: string): string | undefined {
  return new RegExp(`>${label}</dt><dd[^>]*>([^<]*)</dd>`).exec(html)?.[1];
}

describe("the integration overview", () => {
  it("counts and links only the dependents this space lists", () => {
    const html = renderOverview(["@acme/here", "@acme/elsewhere"]);
    const t = i18nModule.default.getFixedT("fr", "settings");
    expect(statValue(html, t("integration.summary.agentsCount"))).toBe("1");
    expect(html).toContain('href="/agents/@acme/here"');
    expect(html).not.toContain("@acme/elsewhere");
    expect(html).not.toContain("@acme/unrelated");
  });

  it("opens the tools at their section's address, carrying nothing else", () => {
    const html = renderOverview([]);
    expect(html).toContain('href="/integrations/@acme/gmail?integrationSettings=tools#settings"');
  });

  it("counts the working space's connections out of the mode", () => {
    const html = renderOverview([], { spaceIds: ["spc_a", "spc_b"] });
    const t = i18nModule.default.getFixedT("fr", "settings");
    expect(statValue(html, t("integration.summary.connections"))).toBe("0");
  });

  it("counts the reader's own connections across the integration's spaces in the mode", () => {
    const html = renderOverview([], { overview: true, spaceIds: ["spc_a", "spc_b"] });
    const t = i18nModule.default.getFixedT("fr", "settings");
    // The space-scoped one in spc_b and the org-scoped one; not spc_c's, not another org's.
    expect(statValue(html, t("integration.summary.connections"))).toBe("2");
    expect(statValue(html, t("integration.summary.reauthorize"))).toBe("1");
  });

  it("waits for the integration's spaces before giving a figure in the mode", () => {
    const html = renderOverview([], { overview: true });
    const t = i18nModule.default.getFixedT("fr", "settings");
    const label = t("integration.summary.connections");
    expect(statValue(html, label)).toBeUndefined();
    expect(html).toMatch(new RegExp(`>${label}</dt><dd[^>]*><span class="relative block`));
  });
});
