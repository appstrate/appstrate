// SPDX-License-Identifier: Apache-2.0

/** `/` and the way back to it, for a role with and without the Studio. */

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: { chat: true }, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");
const { HomePage } = await import("../home-page.tsx");
const { NotFoundPage } = await import("../../components/route-gate.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const DENIED = "Vous n'avez pas accès à cette page.";

/** `node` standing in spc_a, whose role grants `permissions`, the Studio only when `studio`. */
const inSpace = (node: ReactElement, permissions: string[], studio: boolean) =>
  renderInSpace(node, {
    overview: false,
    queryClient: memberSpaceClient([testSpace("spc_a", permissions, "Atelier", { studio })]),
  });

describe("HomePage", () => {
  it("sends a role without the Studio to the chat: no dashboard, no refusal", () => {
    // `Navigate` draws no markup; the redirect itself is `homeOf`'s (lib/test/home-route.test.ts).
    expect(inSpace(<HomePage />, ["chat:read"], false)).toBe("");
  });

  it("refuses a role with neither the Studio nor the chat", () => {
    expect(inSpace(<HomePage />, [], false)).toContain(DENIED);
  });
});

describe("NotFoundPage", () => {
  it("leads back to the dashboard where the Studio opens", () => {
    const html = inSpace(<NotFoundPage />, ["chat:read"], true);
    expect(html).toContain('href="/"');
    expect(html).toContain("Dashboard");
  });

  it("leads a role without the Studio back to the chat, named so", () => {
    const html = inSpace(<NotFoundPage />, ["chat:read"], false);
    expect(html).toContain('href="/chat"');
    expect(html).toContain(">Chat<");
    expect(html).not.toContain("Dashboard");
  });
});
