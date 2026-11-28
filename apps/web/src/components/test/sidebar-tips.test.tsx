// SPDX-License-Identifier: Apache-2.0

/**
 * The getting-started cards of the sidebar's foot: which one is on top, which one peeks behind it,
 * and what the controls name. Rotation runs in an effect, which a static render never starts: its
 * order is the list's, pinned by `lib/test/sidebar-tips.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

const storage = installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { SidebarTips } = await import("../sidebar-tips.tsx");
const { authStore } = await import("../../stores/auth-store.ts");
await import("../../stores/sidebar-tips-store.ts");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");

await i18nReady;
await i18n.changeLanguage("fr");

/** The tips of a member of spc_a holding `permissions`, with no connection of their own. */
function tips(
  permissions: string[],
  { userId = "u_1", path = "/" }: { userId?: string; path?: string } = {},
) {
  // The tips store follows the auth store: signing the user in binds their dismissed cards.
  authStore.setState({ user: { id: userId, email: "u@example.test", emailVerified: true } });
  const queryClient = memberSpaceClient([testSpace("spc_a", permissions)]);
  queryClient.setQueryData(["get", "/api/me/connections", {}], { object: "list", data: [] });
  return renderInSpace(<SidebarTips />, {
    overview: false,
    queryClient,
    userId,
    initialEntries: [path],
  });
}

/** The card ids in the stack, in their drawing order, each with its depth (0 is on top). */
function stack(html: string): string[] {
  return [...html.matchAll(/data-tip="([a-z]+)" data-depth="(\d)"/g)].map(
    ([, id, d]) => `${id}:${d}`,
  );
}

describe("SidebarTips", () => {
  it("draws the catalogue alone where nothing else is open to the caller", () => {
    const html = tips(["spaces:read"]);
    expect(stack(html)).toEqual(["catalogue:0"]);
    expect(html).toContain("Explorez le catalogue");
    expect(html).toContain('href="/catalogue/agent"');
    // One card: nothing to turn to.
    expect(html).not.toContain("Carte suivante");
  });

  it("puts the first step on top, the next one peeking, and names it on the turn control", () => {
    const html = tips(["spaces:read", "integrations:read", "integrations:connect"]);
    expect(stack(html)).toEqual(["connect:0", "catalogue:1"]);
    expect(html).toContain("Branchez vos outils");
    expect(html).toContain('href="/integrations"');
    expect(html).toContain('aria-label="Carte suivante : Explorez le catalogue"');
    expect(html).toContain('aria-label="Masquer la carte « Branchez vos outils »"');
    // Only the card on top takes the focus and is read out.
    expect(html).toMatch(/inert="" data-tip="catalogue"/);
    expect(html).not.toMatch(/inert="" data-tip="connect"/);
  });

  it("leaves out a card the person dismissed", () => {
    storage.setItem("appstrate:web:sidebarTips:u_dismissed", JSON.stringify(["connect"]));
    expect(
      stack(
        tips(["spaces:read", "integrations:read", "integrations:connect"], {
          userId: "u_dismissed",
        }),
      ),
    ).toEqual(["catalogue:0"]);
  });

  it("says nothing of the page already on screen", () => {
    expect(
      stack(
        tips(["spaces:read", "integrations:read", "integrations:connect"], {
          path: "/integrations",
        }),
      ),
    ).toEqual(["catalogue:0"]);
  });
});
