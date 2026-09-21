// SPDX-License-Identifier: Apache-2.0

/**
 * The "Activer l'intégration" control an agent's dependency card offers, against
 * the ONE activation verdict this tree has.
 *
 * "May I activate here?" has one answer, `maySetPackageActive`, and every
 * control that offers the act asks it — the library's switch, the package
 * dropdown, and this card's CTA. The org∪space union `can()` computes is NOT
 * that answer and cannot be: a guest in their OWN personal space holds
 * `operator`, which carries no `integrations:install`, while
 * `gateSpacePackageWrite` waives the activation grants there because owning the
 * space IS the authorization (RBAC spec §3.6). A control that decides for
 * itself therefore hides a button the route accepts, next to a dropdown
 * offering its mirror image.
 *
 * These cases pin that this card reads the verdict, in both directions.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

const SPACE_ID = "spc_target";

// The stores read `localStorage` at module init, so it exists before the
// dynamic imports below pull them in.
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { AgentIntegrationsBlock } = await import("../package-detail/agent-integrations-block.tsx");
const { spaceStore } = await import("../../stores/space-store.ts");
const { $api } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const i18n = i18nModule.default;

/** One row of `GET /api/spaces`, in the two shapes the verdict tells apart. */
function spaceFixture(permissions: string[], personal: boolean) {
  return {
    object: "space" as const,
    id: SPACE_ID,
    orgId: "org_a",
    name: "Target",
    isDefault: false,
    settings: {},
    visibility: "open" as const,
    default_role: "viewer",
    personal,
    access: "member" as const,
    role: null,
    permissions,
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

/**
 * Render the dependency card for an integration that is NOT active here — the
 * `/api/integrations` list is empty, which is exactly "nothing is active in
 * this space" — with the caller's standing in the target space seeded.
 */
function cardFor(permissions: string[], personal: boolean): string {
  const qc = new QueryClient();
  // No org is selected in this harness, so every scoped query is `enabled:
  // false` and serves the cache verbatim — which is what the seeds below are.
  const orgHeader = { "X-Org-Id": undefined };
  const scoped = { header: { ...orgHeader, "X-Space-Id": SPACE_ID } };

  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: orgHeader } }).queryKey,
    {
      object: "list",
      data: [spaceFixture(permissions, personal)],
      hasMore: false,
    },
  );
  qc.setQueryData($api.queryOptions("get", "/api/integrations", { params: scoped }).queryKey, {
    object: "list",
    data: [],
    hasMore: false,
  });
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}", {
      params: { path: { packageId: "@acme/gmail" }, ...scoped },
    }).queryKey,
    { manifest: { display_name: "Gmail" }, auths: [] },
  );

  // `renderToStaticMarkup` takes zustand's SERVER snapshot, so the current
  // space is seeded on `getInitialState` — seeding `localStorage` would be too
  // late: the whole suite shares one module registry and the store read it at
  // its first import, in whichever file got there first.
  const snapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(
      <AgentIntegrationsBlock
        entries={[{ id: "@acme/gmail", version: "1.0.0", tools: undefined, scopes: undefined }]}
      />,
      { queryClient: qc },
    );
  } finally {
    snapshot.mockRestore();
  }
}

/** The card's activation button, as its open tag — `disabled` is an attribute. */
function activateButton(html: string): { tag: string; disabled: boolean } {
  const tag = /<button\b[^>]*data-testid="integration-activate-@acme\/gmail"[^>]*>/.exec(html)?.[0];
  expect(tag, html).toBeDefined();
  return { tag: tag!, disabled: / disabled=""/.test(tag!) };
}

describe("a guest in their own personal space", () => {
  it("gets a live activation button, with no grant anywhere", () => {
    // `operator` in a personal space carries no `integrations:install`; the
    // route accepts all the same, and so must the button.
    const button = activateButton(cardFor([], true));
    expect(button.disabled).toBe(false);
    expect(button.tag).not.toContain(i18n.t("library.cannotActivate", { ns: "common" }));
  });
});

describe("a member of a TEAM space without the grant", () => {
  it("CONTROL: gets the button dead, with the refusal on it", () => {
    const button = activateButton(cardFor([], false));
    expect(button.disabled).toBe(true);
    expect(button.tag).toContain(i18n.t("library.cannotActivate", { ns: "common" }));
  });

  it("CONTROL: holding `integrations:install` there brings it back", () => {
    const button = activateButton(cardFor(["integrations:install"], false));
    expect(button.disabled).toBe(false);
  });
});
