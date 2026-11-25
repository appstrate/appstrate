// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "bun:test";
import { installSpaStorage } from "../../../test/fake-storage.ts";
import type { ToolPolicy } from "../../../lib/integration-tool-policy.ts";
import type { ToolDeclaration } from "../integration-tool-policy-section.tsx";

// The definition diff reaches the editor's theme store, which touches `matchMedia` and the
// document root on import.
installSpaStorage({ matchMedia: () => ({ matches: false, addEventListener: () => {} }) });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: { classList: { add: () => {}, remove: () => {} } },
    querySelector: () => null,
  },
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const { i18nReady } = await import("../../../i18n.ts");
const { render } = await import("../../../test/render.tsx");
const { IntegrationToolPolicySection, ToolPolicyView } =
  await import("../integration-tool-policy-section.tsx");

await i18nReady;

const noop = () => {};
const view = (
  policy: ToolPolicy,
  tools: { name: string; status?: string; origin?: string }[],
  options: { review?: boolean; declaration?: ToolDeclaration } = {},
) =>
  render(
    <ToolPolicyView
      policy={policy}
      tools={tools}
      review={options.review ?? true}
      declaration={options.declaration}
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

describe("ToolPolicyView declaration", () => {
  const empty: ToolPolicy = { listed: [], approvals: [], blocks: [] };
  const catalog = [
    { name: "search", status: "pending", origin: "listed" },
    { name: "open", status: "available", origin: "listed" },
    { name: "mine", status: "available", origin: "declared" },
  ];
  const declaration = (declared: string[] = []): ToolDeclaration => ({
    declared: new Set(declared),
    declare: noop,
  });

  it("offers to declare reviewed and unreviewed listed tools, never the declared ones", () => {
    const html = view(empty, catalog, { declaration: declaration() });
    expect(html).toContain('data-testid="tool-declare-search"');
    expect(html).toContain('data-testid="tool-undeclared-open"');
    expect(html).toContain('data-testid="tool-declare-open"');
    expect(html).not.toContain('data-testid="tool-declare-mine"');
    expect(html).toContain("Déclarer dans l’intégration");
    expect(html).toContain('data-testid="tool-declare-all"');
  });

  it("offers nothing to declare without a declaration", () => {
    const html = view(empty, catalog);
    expect(html).not.toContain("tool-declare-");
    expect(html).not.toContain("Déclarer");
  });

  it("says a tool is declared in the draft, and drops the bulk action when none remains", () => {
    const html = view(empty, catalog, { declaration: declaration(["search", "open"]) });
    expect(html).toContain('data-testid="tool-declared-search"');
    expect(html).toContain("Déclaré dans le brouillon");
    expect(html).not.toContain('data-testid="tool-declare-open"');
    expect(html).not.toContain('data-testid="tool-declare-all"');
  });

  it("keeps the declarations and drops the decisions for a reader who cannot configure", () => {
    const html = view(empty, catalog, { review: false, declaration: declaration() });
    expect(html).toContain('data-testid="tool-undeclared-search"');
    expect(html).toContain('data-testid="tool-declare-all"');
    expect(html).not.toContain('data-testid="tool-review-search"');
    expect(html).not.toContain("Approuver");
    expect(html).not.toContain("Bloquer");
  });
});

describe("IntegrationToolPolicySection", () => {
  const declaration: ToolDeclaration = { declared: new Set(), declare: noop };

  it("renders nothing without a space review nor a declaration", () => {
    expect(
      render(<IntegrationToolPolicySection packageId="@acme/crm" tools={[]} review={false} />),
    ).toBe("");
  });

  it("offers the declare controls to an author outside the review, without the space policy", () => {
    const html = render(
      <IntegrationToolPolicySection
        packageId="@acme/crm"
        tools={[{ name: "export_notes", status: "pending", origin: "listed" }]}
        review={false}
        declaration={declaration}
      />,
    );
    expect(html).toContain('data-testid="tool-declare-export_notes"');
    expect(html).not.toContain("Approuver");
  });
});
