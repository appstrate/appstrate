// SPDX-License-Identifier: Apache-2.0

/**
 * The "Activer l'intégration" control an agent's dependency card offers, against
 * the ONE activation verdict this tree has.
 *
 * "May I activate here?" has one answer, the verdict the server serves on the
 * package's library row (`activation`), and every control that offers the act
 * reads it — the library's switch, the package dropdown, and this card's CTA.
 * The org∪space union `can()` computes is NOT that answer and cannot be: a guest
 * in their OWN personal space holds `operator`, which carries no
 * `integrations:install`, while `gateSpacePackageWrite` waives the activation
 * grants there because owning the space IS the authorization (RBAC spec §3.6).
 * A control that decides for itself therefore hides a button the route accepts.
 *
 * These cases pin that this card reads the served verdict, in every direction.
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

/**
 * Render the dependency card for an integration that is NOT active here — its
 * own detail says `active: false` — with the caller's standing in the target
 * space seeded.
 */
function cardFor(verdict: "allowed" | "not_shareable" | "forbidden" | null): string {
  const qc = new QueryClient();
  // No org is selected in this harness, so every scoped query is `enabled:
  // false` and serves the cache verbatim — which is what the seeds below are.
  const orgHeader = { "X-Org-Id": undefined };
  const scoped = { header: { ...orgHeader, "X-Space-Id": SPACE_ID } };

  // The current space's library, whose row carries the served verdict; a null
  // verdict is a row with no cell for this space.
  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces/{spaceId}/library", {
      params: { path: { spaceId: SPACE_ID }, header: orgHeader },
    }).queryKey,
    {
      object: "library",
      spaces: [],
      packages: {
        agent: [],
        skill: [],
        "mcp-server": [],
        integration: [
          {
            id: "@acme/gmail",
            placements: [],
            activation: verdict
              ? [{ spaceId: SPACE_ID, activate: verdict, deactivate: verdict }]
              : [],
          },
        ],
      },
    },
  );
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}", {
      params: { path: { packageId: "@acme/gmail" }, ...scoped },
    }).queryKey,
    { manifest: { display_name: "Gmail" }, auths: [], active: false },
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
        agentPackageId="@acme/agent"
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

describe("the activation button", () => {
  it("is live when the server allows the act", () => {
    const button = activateButton(cardFor("allowed"));
    expect(button.disabled).toBe(false);
    expect(button.tag).not.toContain(i18n.t("library.cannotActivate", { ns: "common" }));
  });

  it("CONTROL: is dead, with the refusal on it, when the server forbids it", () => {
    const button = activateButton(cardFor("forbidden"));
    expect(button.disabled).toBe(true);
    expect(button.tag).toContain(i18n.t("library.cannotActivate", { ns: "common" }));
  });

  it("CONTROL: is dead for a package that cannot be shared here", () => {
    expect(activateButton(cardFor("not_shareable")).disabled).toBe(true);
  });

  it("CONTROL: is dead while the library has no verdict for this space", () => {
    expect(activateButton(cardFor(null)).disabled).toBe(true);
  });
});
