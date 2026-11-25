// SPDX-License-Identifier: Apache-2.0

/**
 * An integration's Paramètres in « Tous les espaces »: the Configuration group opens where one of
 * the integration's spaces grants `integrations:configure`, and its sections start with the space
 * they are set in, named, with the way to another. With a space selected, that space's grant alone.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { installSpaStorage } from "../../test/fake-storage.ts";
import type { IntegrationDetailWire } from "../../hooks/use-integrations.ts";

installSpaStorage({
  location: { pathname: "/", origin: "http://localhost" },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
});
// The editor's theme store touches the document root on import.
await import("sonner");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: { classList: { add: () => {}, remove: () => {} } },
    querySelector: () => null,
  },
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");
const { IntegrationSettings } = await import("../integration-detail.tsx");
const { useIntegrationSpaceAction } =
  await import("../../components/integration-detail/use-integration-space.ts");

await i18nReady;
await i18n.changeLanguage("fr");
const agentsT = i18n.getFixedT("fr", "agents");
const settingsT = i18n.getFixedT("fr", "settings");

const DETAIL = {
  active: true,
  auths: [],
  manifest: {},
  tool_catalog: [],
  block_user_connections: false,
} as unknown as IntegrationDetailWire;

/** The page's wiring: the configuration space is the page's, handed down. */
function Settings({
  spaceIds,
  active,
  remote = false,
}: {
  spaceIds: string[];
  active: boolean;
  remote?: boolean;
}) {
  const configureIn = useIntegrationSpaceAction("@acme/crm", "integrations:configure", spaceIds);
  return (
    <IntegrationSettings
      packageId="@acme/crm"
      detail={{
        ...DETAIL,
        active,
        manifest: (remote ? { source: { kind: "remote" } } : {}) as typeof DETAIL.manifest,
      }}
      blockUserConnections={false}
      spaceIds={spaceIds}
      configureIn={configureIn}
      isOwned={false}
      versionGrants={{ canRestore: false, canDelete: false }}
    />
  );
}

function settings(
  overview: boolean,
  workingGrants: string[],
  spaceIds = ["spc_a", "spc_b"],
  active = true,
) {
  const queryClient = memberSpaceClient([
    testSpace("spc_a", ["integrations:read", ...workingGrants], "Studio"),
    testSpace("spc_b", ["integrations:read", "integrations:configure"], "Coffre"),
  ]);
  return renderInSpace(<Settings spaceIds={spaceIds} active={active} />, {
    overview,
    queryClient,
    initialEntries: ["/integrations/@acme/crm?integrationSettings=authentication#settings"],
  });
}

const GROUP = `>${agentsT("detail.settings.configurationGroup")}<`;
const SPACE_LINE = agentsT("detail.configuration.spaceLabel");
const HINT = 'data-testid="activation-hint"';
const ACTIVATE = 'data-testid="detail-activate-btn"';

describe("an integration's configuration in « Tous les espaces »", () => {
  it("opens where another of its spaces grants it, naming the working space the role refuses", () => {
    const html = settings(true, []);
    expect(html).toContain(GROUP);
    expect(html).toContain(SPACE_LINE);
    expect(html).toContain(
      settingsT("integration.config.roleLimitIn", { space: "Studio" }).replace(/'/g, "&#x27;"),
    );
  });

  it("shows the section from the working space when it grants it, the space named", () => {
    const html = settings(true, ["integrations:configure"]);
    expect(html).toContain(SPACE_LINE);
    expect(html).toContain(">Studio<");
    expect(html).toContain(settingsT("integration.auth.none").replace(/'/g, "&#x27;"));
  });

  it("draws nothing of the working space it is off in: the line enters the space it is on in", () => {
    // Active in Coffre only, off in the working space Studio: no hint, no « Activer » acting there.
    const html = settings(true, ["integrations:configure"], ["spc_b"], false);
    expect(html).toContain(agentsT("detail.configuration.spaceChoiceIn", { space: "Coffre" }));
    expect(html).not.toContain(HINT);
    expect(html).not.toContain(ACTIVATE);
    expect(html).not.toContain("Studio");
  });

  it("stays closed when none of its spaces grants it", () => {
    // CONTROL: the integration is active in the working space only, which refuses.
    expect(settings(true, [], ["spc_a"])).not.toContain(GROUP);
  });
});

describe("an integration's configuration with a space selected", () => {
  it("follows the working space's grant alone", () => {
    expect(settings(false, [])).not.toContain(GROUP);
    const html = settings(false, ["integrations:configure"]);
    expect(html).toContain(GROUP);
    expect(html).not.toContain(SPACE_LINE);
  });

  it("points at the header's « Activer » while it is off, without a second button", () => {
    const html = settings(false, ["integrations:configure"], ["spc_b"], false);
    expect(html).toContain(HINT);
    expect(html).toContain(settingsT("integrations.activate.hint").replace(/'/g, "&#x27;"));
    expect(html).not.toContain(ACTIVATE);
  });
});

// The tool review is one space's, like the sections of the Configuration group: it follows the
// same lines and never reads or writes a space the page does not name.
describe("an integration's tool review", () => {
  const POLICY = 'data-testid="integration-tool-policy"';
  const AREA = 'data-testid="integration-tool-policy-area"';
  const POLICY_KEY = [
    "get",
    "/api/integrations/{packageId}/tool-policy",
    {
      params: {
        path: { packageId: "@acme/crm" },
        header: { "X-Org-Id": "org_1", "X-Space-Id": "spc_a" },
      },
    },
  ];

  function tools(
    overview: boolean,
    workingGrants: string[],
    spaceIds = ["spc_a", "spc_b"],
    active = true,
  ) {
    const queryClient = memberSpaceClient([
      testSpace("spc_a", ["integrations:read", ...workingGrants], "Studio"),
      testSpace("spc_b", ["integrations:read", "integrations:configure"], "Coffre"),
    ]);
    queryClient.setQueryData(POLICY_KEY, { listed: [], approvals: [], blocks: [] });
    return renderInSpace(<Settings spaceIds={spaceIds} active={active} remote />, {
      overview,
      queryClient,
      initialEntries: ["/integrations/@acme/crm?integrationSettings=tools#settings"],
    });
  }

  it("names the space it is set in, in « Tous les espaces »", () => {
    const html = tools(true, ["integrations:configure"]);
    expect(html).toContain(AREA);
    expect(html).toContain(SPACE_LINE);
    expect(html).toContain(POLICY);
  });

  it("reads nothing of the working space it is off in", () => {
    const html = tools(true, ["integrations:configure"], ["spc_b"]);
    expect(html).toContain(SPACE_LINE);
    expect(html).not.toContain(POLICY);
  });

  it("points at « Activer » while the integration is off, and says what the role refuses", () => {
    expect(tools(false, ["integrations:configure"], ["spc_b"], false)).toContain(HINT);
    const refused = tools(true, []);
    expect(refused).toContain(
      settingsT("integration.config.roleLimitIn", { space: "Studio" }).replace(/'/g, "&#x27;"),
    );
    expect(refused).not.toContain(POLICY);
  });

  it("is absent where no space of the integration offers configuring it", () => {
    expect(tools(true, [], ["spc_a"])).not.toContain(AREA);
    expect(tools(false, [])).not.toContain(AREA);
  });

  it("shows plainly with a space selected", () => {
    const html = tools(false, ["integrations:configure"]);
    expect(html).toContain(POLICY);
    expect(html).not.toContain(SPACE_LINE);
  });
});
