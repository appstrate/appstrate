// SPDX-License-Identifier: Apache-2.0

/**
 * An integration's Paramètres in « Tous les espaces »: the Configuration group opens where one of
 * the integration's spaces grants `integrations:configure`, and its sections start with the space
 * they are set in, named, with the way to another. With a space selected, that space's grant alone.
 */

import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { IntegrationDetailWire } from "../../hooks/use-integrations.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
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

const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");
const { IntegrationSettings } = await import("../integration-detail.tsx");

await i18nReady;
await i18n.changeLanguage("fr");
const agentsT = i18n.getFixedT("fr", "agents");
const settingsT = i18n.getFixedT("fr", "settings");

const space = (id: string, name: string, permissions: string[]) => ({
  id,
  object: "space",
  access: "member",
  permissions,
  personal: false,
  isDefault: id === "spc_a",
  name,
  role: null,
});

const DETAIL = {
  active: true,
  auths: [],
  manifest: {},
  tool_catalog: [],
  block_user_connections: false,
} as unknown as IntegrationDetailWire;

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
});

function settings(overview: boolean, workingGrants: string[], spaceIds = ["spc_a", "spc_b"]) {
  stubs = [
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: "org_1",
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_a",
    }),
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_1", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: overview ? { "u_1:org_1": true } : {},
    }),
  ];
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
    {
      object: "list",
      hasMore: false,
      data: [
        space("spc_a", "Studio", ["integrations:read", ...workingGrants]),
        space("spc_b", "Coffre", ["integrations:read", "integrations:configure"]),
      ],
    },
  );
  return render(
    <IntegrationSettings
      packageId="@acme/crm"
      detail={DETAIL}
      blockUserConnections={false}
      spaceIds={spaceIds}
      isOwned={false}
      versionGrants={{ canRestore: false, canDelete: false }}
    />,
    {
      queryClient,
      initialEntries: ["/integrations/@acme/crm?integrationSettings=authentication#settings"],
    },
  );
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
