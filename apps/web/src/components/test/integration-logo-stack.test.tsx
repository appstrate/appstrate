// SPDX-License-Identifier: Apache-2.0

/**
 * The integrations of an agent on its card and its row: their logos stacked, the rest counted,
 * the names in the label, a required one not active in the space dimmed and said so.
 */

import { describe, expect, it } from "bun:test";
import type { AgentListIntegration } from "@appstrate/shared-types";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { render } from "../../test/render.tsx";
import { IntegrationLogoStack } from "../integration-logo-stack.tsx";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

const integration = (id: string, name: string): AgentListIntegration => ({
  id,
  name,
  icon: null,
  required: true,
  authenticated: true,
});

const tiles = (html: string) => (html.match(/data-testid="integration-logo"/g) ?? []).length;

describe("IntegrationLogoStack", () => {
  it("draws a tile per integration and names them all in the label", () => {
    const html = render(
      <IntegrationLogoStack
        integrations={[integration("@a/gmail", "Gmail"), integration("@a/notion", "Notion")]}
      />,
    );
    expect(tiles(html)).toBe(2);
    expect(html).toContain('aria-label="Intégrations : Gmail, Notion"');
  });

  it("counts the integrations past four, still naming every one", () => {
    const names = ["A", "B", "C", "D", "E", "F"];
    const html = render(
      <IntegrationLogoStack integrations={names.map((name) => integration(`@a/${name}`, name))} />,
    );
    expect(tiles(html)).toBe(4);
    expect(html).toMatch(/>\+2<\/span>/);
    expect(html).toContain("Intégrations : A, B, C, D, E, F");
  });

  it("dims a required integration not active in the space and says so", () => {
    const html = render(
      <IntegrationLogoStack
        integrations={[integration("@a/gmail", "Gmail"), integration("@a/notion", "Notion")]}
        inactive={["@a/notion"]}
      />,
    );
    expect((html.match(/opacity-40 grayscale/g) ?? []).length).toBe(1);
    expect(html).toContain("Gmail, Notion (non activée dans cet espace)");
  });

  it("draws nothing for an agent using no integration", () => {
    expect(render(<IntegrationLogoStack integrations={[]} />)).toBe("");
  });
});
