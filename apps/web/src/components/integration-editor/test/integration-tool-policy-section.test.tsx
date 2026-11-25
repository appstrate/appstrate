// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import type { ToolPolicy } from "../../../lib/integration-tool-policy.ts";
import { ToolPolicyView } from "../integration-tool-policy-section.tsx";

await i18nReady;

const noop = () => {};
const view = (policy: ToolPolicy, tools: { name: string; status?: string }[]) =>
  render(
    <ToolPolicyView
      policy={policy}
      tools={tools}
      busy={false}
      onApprove={noop}
      onBlock={noop}
      onRevoke={noop}
      onUnblock={noop}
    />,
  );

describe("ToolPolicyView", () => {
  it("shows a pending tool with its definition, and both definitions when it replaces one", () => {
    const html = view(
      {
        listed: [{ name: "search", fingerprint: "b", definition: { description: "Search v2" } }],
        approvals: [
          {
            tool_name: "search",
            fingerprint: "a",
            definition: { description: "Search v1" },
            approved_by: null,
            approved_at: "2026-11-01T00:00:00.000Z",
          },
        ],
        blocks: [],
      },
      [{ name: "search", status: "pending" }],
    );
    expect(html).toContain('data-testid="tool-review-search"');
    expect(html).toContain("Approuver");
    expect(html).toContain("Bloquer");
    expect(html).toContain("Définition approuvée");
    expect(html).toContain("Search v1");
    expect(html).toContain("Search v2");
    expect(html).toContain("Retirer l&#x27;approbation".replace("&#x27;", "’"));
  });

  it("explains a definition too large to keep", () => {
    const html = view(
      { listed: [{ name: "big", fingerprint: "x", definition: null }], approvals: [], blocks: [] },
      [{ name: "big", status: "pending" }],
    );
    expect(html).toContain("Définition trop volumineuse, non conservée");
  });

  it("lists the blocked tools with their way back, and says when nothing waits", () => {
    const html = view(
      {
        listed: [],
        approvals: [],
        blocks: [{ tool_name: "export", blocked_by: null, blocked_at: "2026-11-02T00:00:00.000Z" }],
      },
      [{ name: "export", status: "blocked" }],
    );
    expect(html).toContain("Aucun outil à examiner");
    expect(html).toContain('data-testid="tool-policy-export"');
    expect(html).toContain("Débloquer");
  });
});
