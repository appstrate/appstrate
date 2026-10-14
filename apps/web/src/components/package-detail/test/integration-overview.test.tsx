// SPDX-License-Identifier: Apache-2.0

/**
 * The integration overview. Its dependents come from the package read, which
 * counts the organization's agents in every space; it names and links only the
 * ones this space lists, the others' pages answering 404 from here. Its tools
 * stat opens Paramètres › Outils at the section's own address.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { IntegrationOverview } = await import("../integration-overview.tsx");
const { orgStore } = await import("../../../stores/org-store.ts");
const { spaceStore } = await import("../../../stores/space-store.ts");
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

function renderOverview(dependentIds: string[]): string {
  const queryClient = new QueryClient();
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
  try {
    return render(
      <IntegrationOverview
        detail={DETAIL}
        dependentIds={dependentIds}
        onOpenConnections={() => {}}
      />,
      { queryClient, initialEntries: ["/integrations/@acme/gmail?other=1"] },
    );
  } finally {
    org.mockRestore();
    space.mockRestore();
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
    expect(html).toContain(
      'href="/integrations/@acme/gmail?integrationSettings=tools#configuration"',
    );
  });
});
