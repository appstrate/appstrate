// SPDX-License-Identifier: Apache-2.0

/**
 * The "no model" banner names a remedy its reader can perform: the settings
 * page for a caller holding `models:write`, an administrator for anyone else.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { ModelRequiredAlert } = await import("../package-detail/model-required-alert.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const { $api } = await import("../../api/client.ts");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const header = { "X-Org-Id": ORG_ID };

function renderAlert(orgPermissions: string[]): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions: orgPermissions,
        createdAt: "2026-09-05T10:00:00Z",
        deleting_at: null,
      },
    ],
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/models", { params: { header } }).queryKey,
    { object: "list", data: [], hasMore: false },
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(<ModelRequiredAlert />, { queryClient });
  } finally {
    org.mockRestore();
  }
}

describe("the no-model banner", () => {
  it("sends a caller who may configure models to the organization settings", () => {
    const html = renderAlert(["models:read", "models:write"]);
    expect(html).toContain("Configurez un modèle dans les paramètres de l'organisation");
  });

  it("sends anyone else to an administrator, not to a page they cannot edit", () => {
    const html = renderAlert(["models:read"]);
    expect(html).toContain(
      "Demandez à un administrateur de l'organisation de configurer un modèle",
    );
    expect(html).not.toContain("Configurez un modèle dans les paramètres");
  });
});
