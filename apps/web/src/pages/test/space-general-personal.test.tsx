// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { WorkspaceSettingsGeneralPage } from "../workspace-settings/general.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { spaceStore } from "../../stores/space-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

function generalPage(personal: boolean, domains: string[] = []): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: "org_general",
    name: "General",
    slug: "general",
    icon: null,
    color: null,
    role: "owner",
    deleting_at: null,
    permissions: ["org:read", "spaces:delete"],
    createdAt: "2026-09-05T00:00:00Z",
  };
  const space: components["schemas"]["SpaceObject"] = {
    object: "space",
    id: "spc_general",
    orgId: org.id,
    name: personal ? "Mon espace" : "Equipe",
    icon: null,
    color: null,
    isDefault: false,
    settings: { allowedRedirectDomains: domains },
    visibility: personal ? "private" : "open",
    default_role: "viewer",
    personal,
    access: "member",
    role: null,
    permissions: [],
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
  const header = { "X-Org-Id": org.id };
  queryClient.setQueryData(["orgs"], [org]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey,
    { object: "list", data: [space], hasMore: false },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces/{id}", { params: { path: { id: space.id }, header } })
      .queryKey,
    space,
  );
  try {
    return render(<WorkspaceSettingsGeneralPage />, { queryClient });
  } finally {
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
  }
}

describe("a workspace's general settings", () => {
  it("keeps only the name and one sentence for a personal workspace", () => {
    const html = generalPage(true);
    expect(html).toContain("Nom");
    expect(html).toContain("toujours privé");
    expect(html).not.toContain("Visibilité");
    expect(html).not.toContain("Domaines de redirection");
    expect(html).not.toContain("Zone de danger");
    expect(html).not.toContain('role="radiogroup"');
    // The server refuses an icon or a colour on a personal space: it is drawn as its owner.
    expect(html).not.toContain("Icône et couleur");
  });

  it("shows every setting of a team workspace", () => {
    const html = generalPage(false);
    expect(html).toContain("Visibilité");
    expect(html).toContain("Domaines de redirection");
    expect(html).toContain("Rôle des accès automatiques");
    expect(html).toContain("Zone de danger");
    expect(html).toContain("Icône et couleur");
    expect(html).not.toContain("toujours privé");
  });

  it("labels each redirect domain and its remove button", () => {
    const html = generalPage(false, ["a.example", "b.example"]);
    expect(html).toContain('aria-label="Domaine de redirection 1"');
    expect(html).toContain('aria-label="Domaine de redirection 2"');
    expect(html.split('aria-label="Retirer ce domaine"')).toHaveLength(3);
  });
});
