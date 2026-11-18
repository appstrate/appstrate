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
  value: { documentElement: { classList: { add: () => {}, remove: () => {} } } },
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
function Settings({ spaceIds }: { spaceIds: string[] }) {
  const configureIn = useIntegrationSpaceAction("@acme/crm", "integrations:configure", spaceIds);
  return (
    <IntegrationSettings
      packageId="@acme/crm"
      detail={DETAIL}
      blockUserConnections={false}
      spaceIds={spaceIds}
      configureIn={configureIn}
      isOwned={false}
      versionGrants={{ canRestore: false, canDelete: false }}
    />
  );
}

function settings(overview: boolean, workingGrants: string[], spaceIds = ["spc_a", "spc_b"]) {
  const queryClient = memberSpaceClient([
    testSpace("spc_a", ["integrations:read", ...workingGrants], "Studio"),
    testSpace("spc_b", ["integrations:read", "integrations:configure"], "Coffre"),
  ]);
  return renderInSpace(<Settings spaceIds={spaceIds} />, {
    overview,
    queryClient,
    initialEntries: ["/integrations/@acme/crm?integrationSettings=authentication#settings"],
  });
}

const GROUP = `>${agentsT("detail.settings.configurationGroup")}<`;
const SPACE_LINE = agentsT("detail.configuration.spaceLabel");

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
});
