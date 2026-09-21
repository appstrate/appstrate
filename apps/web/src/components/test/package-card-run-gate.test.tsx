// SPDX-License-Identifier: Apache-2.0

/**
 * The launch control on an agent card, against the ONE fact the index page
 * carries per row.
 *
 * `GET /api/agents` lists the ACTIVE set — placed in this space and switched on
 * — which is the very predicate the launch routes check. So the card has no
 * second half to report: a row on the index is a row that runs here, and the
 * launcher is live. An agent placed here but switched off is not on this list
 * at all; it lives in the space library, with its switch (RBAC spec §6.8/§6.9).
 *
 * This pins that the card offers no activation verdict of its own — neither a
 * badge nor a disabled launcher — because inventing one would either lie about
 * a row the server already filtered, or need a fact the wire no longer carries.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { PackageCard } = await import("../package-card.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const i18n = i18nModule.default;
const ORG_ID = "org_a";

/** Render one agent card for a caller who holds `agents:run`. */
function agentCard(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions: ["agents:run"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(
      <PackageCard id="@acme/worker" displayName="Worker" type="agent" source="local" />,
      {
        queryClient,
      },
    );
  } finally {
    snapshot.mockRestore();
  }
}

/**
 * The card's only `<button>` is the launcher. Returned as its open tag, where
 * the `disabled` ATTRIBUTE is read — the Tailwind class list carries
 * `disabled:opacity-50` on every render, so a substring test would always pass.
 */
function launchButton(html: string): { tag: string; disabled: boolean } {
  const tag = /<button\b[^>]*>/.exec(html)?.[0];
  expect(tag).toBeDefined();
  return { tag: tag!, disabled: / disabled=""/.test(tag!) };
}

describe("an agent card on the index", () => {
  it("leaves the launcher live: being listed is what makes it runnable", () => {
    const html = agentCard();
    const button = launchButton(html);
    expect(button.disabled).toBe(false);
    expect(button.tag).toContain(i18n.t("detail.run", { ns: "agents" }));
  });

  it("CONTROL: states no activation of its own, in either direction", () => {
    // The two sentences a card would need if the index followed the PLACEMENT
    // rule and had to warn that a listed agent might not run. Both are
    // unanswerable — the row carries no activation fact — so neither may
    // appear through a default or a guess.
    const html = agentCard();
    expect(html).not.toContain(i18n.t("detail.titleNotActive", { ns: "agents" }));
    expect(html).not.toContain("Inactif");
  });
});
