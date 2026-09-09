// SPDX-License-Identifier: Apache-2.0

/**
 * Which requests the models page makes for the role that opens it. React Query
 * fires a query when ANY observer is enabled, so one ungated caller re-opens the
 * request the gated ones closed. Every registration goes through
 * `QueryCache.build` with its own `enabled`, so recording those calls answers
 * "would this render have fetched the credentials?".
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient, type QueryCache } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { OrgSettingsModelsPage } = await import("../org-settings/models.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const CREDENTIALS_PATH = "/api/model-provider-credentials";

/** Every `enabled` an observer registered for `path`, in render order. */
function observerEnabledFlags(cache: QueryCache, path: string): unknown[] {
  const flags: unknown[] = [];
  const build = cache.build.bind(cache);
  spyOn(cache, "build").mockImplementation((client, options, state) => {
    // `build` is declared over the narrower `QueryOptions`; an observer hands it
    // its own defaulted set, `enabled` included.
    if (options.queryKey[1] === path) flags.push((options as { enabled?: unknown }).enabled);
    return build(client, options, state);
  });
  return flags;
}

/** Render the page for a caller holding exactly `permissions`. */
function renderFor(permissions: string[]): { html: string; credentialFlags: unknown[] } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: permissions.length > 1 ? "admin" : "member",
        permissions,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  const credentialFlags = observerEnabledFlags(queryClient.getQueryCache(), CREDENTIALS_PATH);
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return { html: render(<OrgSettingsModelsPage />, { queryClient }), credentialFlags };
  } finally {
    snapshot.mockRestore();
  }
}

const MEMBER = ["models:read"];
const ADMIN = [
  "models:read",
  "models:write",
  "model-provider-credentials:read",
  "model-provider-credentials:write",
];

describe("the models page for a member who can only read models", () => {
  it("registers no enabled observer on the credentials list", () => {
    const { credentialFlags } = renderFor(MEMBER);
    // A disabled page-level observer is fine; one that would fetch is not.
    expect(credentialFlags.filter((enabled) => enabled !== false)).toEqual([]);
  });

  it("renders the models tab, and offers no credentials tab to open", () => {
    const { html } = renderFor(MEMBER);
    expect(html).toContain("Modèles");
    expect(html).not.toContain("Clés de providers de modèles");
  });
});

describe("the models page for an admin who holds the credentials permission", () => {
  it("CONTROL: registers the credentials list enabled, so the gate is the permission", () => {
    const { credentialFlags } = renderFor(ADMIN);
    expect(credentialFlags.length).toBeGreaterThan(0);
    expect(credentialFlags.every((enabled) => enabled === true)).toBe(true);
  });
});
