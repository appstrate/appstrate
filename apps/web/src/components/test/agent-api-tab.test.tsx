// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's API tab offers a key exactly where the keys page exists. A
 * personal space takes no API key (409 `personal_space_takes_no_keys`), so its
 * owner — who holds every `api-keys:*` there — is offered neither "create a
 * key" nor a link to a page the registry removes.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { AgentApiTab } = await import("../package-detail/agent-tabs.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { packageKeys } = await import("../../lib/query-keys.ts");
const { render } = await import("../../test/render.tsx");
const { $api } = await import("../../api/client.ts");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";
const PACKAGE_ID = "@acme/worker";
const KEY_PERMISSIONS = ["agents:read", "api-keys:read", "api-keys:create"];

function renderTab(personal: boolean): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const header = { "X-Org-Id": ORG_ID };
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions: [],
        createdAt: "2026-09-05T10:00:00Z",
        deleting_at: null,
      },
    ],
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey,
    {
      object: "list",
      hasMore: false,
      data: [
        {
          object: "space",
          id: SPACE_ID,
          orgId: ORG_ID,
          name: "Studio",
          isDefault: false,
          settings: {},
          visibility: personal ? "private" : "closed",
          default_role: "viewer",
          personal,
          access: "member",
          role: null,
          permissions: KEY_PERMISSIONS,
          created_by: null,
          createdAt: "2026-09-05T10:00:00Z",
          updatedAt: "2026-09-05T10:00:00Z",
        },
      ],
    },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/api-keys", {
      params: { header: { ...header, "X-Space-Id": SPACE_ID } },
    }).queryKey,
    { object: "list", data: [], hasMore: false },
  );
  queryClient.setQueryData(packageKeys.detail("agents", ORG_ID, SPACE_ID, PACKAGE_ID, null), {
    id: PACKAGE_ID,
  });
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<AgentApiTab packageId={PACKAGE_ID} />, { queryClient });
  } finally {
    org.mockRestore();
    space.mockRestore();
  }
}

describe("the agent API tab's key section", () => {
  it("CONTROL: offers to create a key in a team space", () => {
    const html = renderTab(false);
    expect(html).toContain("curl");
    expect(html).toContain("Créer une clé API");
  });

  it("offers no key in a personal space, and still shows the request", () => {
    const html = renderTab(true);
    expect(html).toContain("curl");
    expect(html).not.toContain("Créer une clé API");
    expect(html).not.toContain("Aucune clé API trouvée.");
    expect(html).not.toContain("/org-settings/space/api-keys");
  });
});
