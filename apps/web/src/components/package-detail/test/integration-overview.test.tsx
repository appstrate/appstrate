// SPDX-License-Identifier: Apache-2.0

/**
 * The integration overview. Its dependents come from the package read, which
 * counts the organization's agents in every space; it names and links only the
 * ones this space lists, the others' pages answering 404 from here. Its tools
 * stat opens Paramètres › Outils at the section's own address. In « Tous les espaces » its
 * connection figures are the reader's own across the integration's spaces, as its index card counts.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { IntegrationOverview } = await import("../integration-overview.tsx");
const { agentsKeys } = await import("../../../lib/query-keys.ts");
const { memberSpaceClient, renderInSpace, testSpace } =
  await import("../../../test/space-context.ts");
const i18nModule = await import("../../../i18n.ts");
type IntegrationDetailWire = import("../../../hooks/use-integrations.ts").IntegrationDetailWire;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_1";
const SPACE_ID = "spc_a";

const AVAILABILITY = {
  via: "shared",
  state: "active",
  shared_by: { user_id: "u_2", name: "Ada" },
  offered_to_org: false,
  org_offerable: false,
};

const DETAIL = {
  active: true,
  availability: AVAILABILITY,
  manifest: { display_name: "Gmail" },
  auths: [{ auth_key: "api", type: "api_key", connections: [] }],
  tool_catalog: [{ name: "send" }, { name: "read" }],
} as unknown as IntegrationDetailWire;

/** An unauthenticated integration (AFPS §7.2): it declares no auths, so binds no connection. */
const UNAUTHENTICATED = { ...DETAIL, auths: [] } as unknown as IntegrationDetailWire;

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
  {
    overview = false,
    spaceIds,
    detail = DETAIL,
  }: { overview?: boolean; spaceIds?: string[]; detail?: IntegrationDetailWire } = {},
): string {
  const queryClient = memberSpaceClient([
    testSpace("spc_a", ["integrations:read"], "Studio"),
    testSpace("spc_b", ["integrations:read"], "Coffre"),
  ]);
  queryClient.setQueryData(["get", "/api/me/connections", {}], MY_CONNECTIONS);
  queryClient.setQueryData(agentsKeys.list(ORG_ID, SPACE_ID), [
    { id: "@acme/here", display_name: "Ici" },
    { id: "@acme/unrelated", display_name: "Sans rapport" },
  ]);
  return renderInSpace(
    <IntegrationOverview
      packageId="@acme/gmail"
      detail={detail}
      spaceIds={spaceIds}
      dependentIds={dependentIds}
      onOpenConnections={() => {}}
    />,
    {
      overview,
      orgId: ORG_ID,
      spaceId: SPACE_ID,
      queryClient,
      initialEntries: ["/integrations/@acme/gmail?other=1"],
    },
  );
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

  it("says there is nothing to connect for an integration declaring no auths", () => {
    const t = i18nModule.default.getFixedT("fr", "settings");
    for (const overview of [false, true]) {
      const html = renderOverview([], {
        overview,
        spaceIds: ["spc_a", "spc_b"],
        detail: UNAUTHENTICATED,
      });
      expect(html).toContain(t("integration.auth.none"));
      expect(html).not.toContain(t("integration.summary.connections"));
      expect(html).not.toContain(t("integration.summary.reauthorize"));
    }
  });

  describe("the availability card", () => {
    const t = i18nModule.default.getFixedT("fr", "settings");
    const withAvailability = (patch: Record<string, unknown>) =>
      ({
        ...DETAIL,
        availability: { ...AVAILABILITY, ...patch },
      }) as unknown as IntegrationDetailWire;

    it("says how the working space got the integration", () => {
      const html = renderOverview([]);
      expect(html).toContain(t("integration.availability.title"));
      expect(statValue(html, t("integration.availability.here"))).toBe(
        t("integration.availability.sharedBy", { name: "Ada" }),
      );
    });

    it("is hidden in « Tous les espaces », which has no working-space answer", () => {
      const html = renderOverview([], { overview: true, spaceIds: ["spc_a"] });
      expect(html).not.toContain(t("integration.availability.title"));
    });

    it("draws the offer row only when the offer stands or the reader may change it", () => {
      const none = renderOverview([]);
      expect(none).not.toContain(t("catalogue.orgOffer.label"));
      for (const patch of [{ org_offerable: true }, { offered_to_org: true }]) {
        const html = renderOverview([], { detail: withAvailability(patch) });
        expect(html).toContain(t("catalogue.orgOffer.label"));
      }
    });
  });
});
