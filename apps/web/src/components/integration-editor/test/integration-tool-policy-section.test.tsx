// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import type { ToolPolicy } from "../../../lib/integration-tool-policy.ts";
import {
  IntegrationToolPolicySection,
  ToolPolicyView,
} from "../integration-tool-policy-section.tsx";

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
  it("shows a pending tool with its definition, as a diff against the approval it replaces", () => {
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
    // The diff's header names both sides; its Monaco body renders client-side only.
    expect(html).toContain("Définition approuvée");
    expect(html).toContain("Définition actuelle");
    expect(html).not.toContain("Search v1");
    expect(html).toContain("Retirer l’approbation");
  });

  it("shows a first definition as a JSON tree, with no diff", () => {
    const html = view(
      {
        listed: [{ name: "search", fingerprint: "a", definition: { description: "Search v1" } }],
        approvals: [],
        blocks: [],
      },
      [{ name: "search", status: "pending" }],
    );
    expect(html).toContain("Search v1");
    expect(html).not.toContain("Définition approuvée");
  });

  it("lists a pending tool no listing carries, with the way to read the server and nothing to approve", () => {
    const html = view({ listed: [], approvals: [], blocks: [] }, [
      { name: "ghost", status: "pending" },
    ]);
    expect(html).toContain('data-testid="tool-review-ghost"');
    expect(html).toContain("Relire le serveur");
    expect(html).not.toContain("Approuver");
    expect(html).toContain("Bloquer");
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

describe("IntegrationToolPolicySection", () => {
  it("renders nothing without integrations:configure in the space", () => {
    expect(render(<IntegrationToolPolicySection packageId="@acme/crm" tools={[]} />)).toBe("");
  });
});
