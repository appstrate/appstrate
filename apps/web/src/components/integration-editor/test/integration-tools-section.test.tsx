// SPDX-License-Identifier: Apache-2.0

/**
 * With no tool catalog (`tools` empty), the section still
 * edits `tools_policy` and `allow_undeclared_tools` straight from the draft.
 */

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { IntegrationToolsSection } from "../integration-tools-section.tsx";

await i18nReady;

const manifest = {
  allow_undeclared_tools: false,
  auths: { primary: { type: "api_key" } },
  tools_policy: { list_issues: { required_scopes: { primary: ["issues:read"] } } },
};

describe("IntegrationToolsSection without a saved catalog", () => {
  it("lists the tools the draft declares a policy for, with their scopes", () => {
    const html = render(
      <IntegrationToolsSection tools={[]} edit={{ manifest, onChange: () => {} }} />,
    );
    expect(html).toContain("list_issues");
    expect(html).toContain("issues:read");
  });

  it("offers the wildcard toggle", () => {
    const html = render(
      <IntegrationToolsSection tools={[]} edit={{ manifest, onChange: () => {} }} />,
    );
    expect(html).toContain('data-testid="integration-editor-allow-undeclared-tools"');
  });
});
