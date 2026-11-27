// SPDX-License-Identifier: Apache-2.0

/**
 * The creation page has no saved package, so no tool catalog: the section still
 * edits `tools_policy` and `allow_undeclared_tools` straight from the draft.
 */

import { describe, expect, it } from "bun:test";
import { installThemeEnv } from "../../../test/theme-env.ts";

installThemeEnv();

const { i18nReady } = await import("../../../i18n.ts");
const { render } = await import("../../../test/render.tsx");
const { IntegrationToolsSection } = await import("../integration-tools-section.tsx");

await i18nReady;

const manifest = {
  allow_undeclared_tools: false,
  auths: { primary: { type: "api_key" } },
  tools_policy: { list_issues: { required_scopes: { primary: ["issues:read"] } } },
};

describe("IntegrationToolsSection without a saved catalog", () => {
  it("lists the tools the draft declares a policy for, with their scopes", () => {
    const html = render(
      <IntegrationToolsSection
        packageId="@acme/crm"
        tools={[]}
        edit={{ manifest, onChange: () => {} }}
      />,
    );
    expect(html).toContain("list_issues");
    expect(html).toContain("issues:read");
  });

  it("offers the wildcard toggle", () => {
    const html = render(
      <IntegrationToolsSection
        packageId="@acme/crm"
        tools={[]}
        edit={{ manifest, onChange: () => {} }}
      />,
    );
    expect(html).toContain('data-testid="integration-editor-allow-undeclared-tools"');
  });
});
