// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { ApiKeysPage } from "../api-keys-page.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { spaceStore } from "../../stores/space-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

/** The empty API keys page of a caller holding `permissions` in the space. */
function emptyApiKeysPage(permissions: string[]): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: "org_keys",
    name: "Keys",
    slug: "keys",
    logo: null,
    role: "guest",
    deleting_at: null,
    permissions: [],
    createdAt: "2026-09-05T00:00:00Z",
  };
  const space: components["schemas"]["SpaceObject"] = {
    object: "space",
    id: "spc_keys",
    orgId: org.id,
    name: "Keys space",
    isDefault: true,
    settings: {},
    visibility: "open",
    default_role: "viewer",
    personal: false,
    access: "member",
    role: null,
    permissions,
    created_by: null,
    createdAt: org.createdAt,
    updatedAt: org.createdAt,
  };
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: org.id,
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: space.id,
  });
  const orgHeader = { "X-Org-Id": org.id };
  const header = { ...orgHeader, "X-Space-Id": space.id };
  queryClient.setQueryData(["orgs"], [org]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: orgHeader } }).queryKey,
    { object: "list", data: [space], hasMore: false },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/api-keys", { params: { header } }).queryKey,
    { object: "list", data: [], hasMore: false },
  );
  try {
    return render(<ApiKeysPage />, { queryClient });
  } finally {
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
  }
}

describe("an empty collection you can add to", () => {
  it("offers the add button to someone who may create", () => {
    const html = emptyApiKeysPage(["api-keys:read", "api-keys:create"]);
    expect(html).toContain("Aucune clé API.");
    // The Actions menu is closed in a static render: this button is the empty state's.
    expect(html).toContain("Nouvelle clé API");
  });

  it("offers nothing to someone who may only read", () => {
    const html = emptyApiKeysPage(["api-keys:read"]);
    expect(html).toContain("Aucune clé API.");
    expect(html).not.toContain("Nouvelle clé API");
  });
});
