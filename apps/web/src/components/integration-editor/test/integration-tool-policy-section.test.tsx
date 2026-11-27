// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { installThemeEnv } from "../../../test/theme-env.ts";
import type { ToolPolicy } from "../../../lib/integration-tool-policy.ts";
import type { ToolDeclaration, ToolPolicyControls } from "../integration-tool-policy-section.tsx";

installThemeEnv();

const { i18nReady } = await import("../../../i18n.ts");
const { render } = await import("../../../test/render.tsx");
const { IntegrationToolPolicySection, ToolPolicyView } =
  await import("../integration-tool-policy-section.tsx");

await i18nReady;

const noop = () => {};
type Row = {
  name: string;
  status?: "available" | "missing" | "pending" | "blocked";
  origin?: "declared" | "approved" | "listed";
};
const approval = (name: string, fingerprint: string, definition = {}) => ({
  tool_name: name,
  fingerprint,
  definition,
  approved_by: null,
  approved_at: "2026-11-01T00:00:00.000Z",
});
const blocked = (name: string) => ({
  tool_name: name,
  blocked_by: null,
  blocked_at: "2026-11-02T00:00:00.000Z",
});
const empty: ToolPolicy = { listed: [], approvals: [], blocks: [] };

/** Renders the view and hands back the controls the table would receive. */
function view(
  policy: ToolPolicy | null,
  tools: Row[],
  options: {
    review?: boolean;
    declaration?: ToolDeclaration;
    pending?: (action: string, name: string) => boolean;
    onApprove?: (items: { name: string; fingerprint: string }[]) => void;
    onUnblock?: (name: string) => void;
  } = {},
) {
  let controls!: ToolPolicyControls;
  const html = render(
    <ToolPolicyView
      policy={policy}
      tools={tools}
      review={options.review ?? true}
      declaration={options.declaration}
      pending={options.pending ?? (() => false)}
      onApprove={options.onApprove ?? noop}
      onBlock={noop}
      onRevoke={noop}
      onUnblock={options.onUnblock ?? noop}
    >
      {(c) => {
        controls = c;
        return null;
      }}
    </ToolPolicyView>,
  );
  const ids = (name: string) => controls.rowActions({ name }).map((action) => action.id);
  return { html, controls, ids };
}

describe("ToolPolicyView review", () => {
  it("shows a pending tool with its definition, as a diff against the approval it replaces, and the way to act", () => {
    const { html } = view(
      {
        listed: [{ name: "search", fingerprint: "b", definition: { description: "Search v2" } }],
        approvals: [approval("search", "a", { description: "Search v1" })],
        blocks: [],
      },
      [{ name: "search", status: "pending" }],
    );
    expect(html).toContain('data-testid="tool-review-search"');
    expect(html).toContain('aria-label="Approuver search"');
    expect(html).toContain('aria-label="Bloquer search"');
    // The diff's header names both sides; its Monaco body renders client-side only.
    expect(html).toContain("Définition approuvée");
    expect(html).toContain("Définition actuelle");
  });

  it("shows a first definition as a JSON tree, with no diff", () => {
    const item = {
      name: "search",
      fingerprint: "a",
      definition: { description: "Search v1", marker: "UniqueField" },
      description: "Search v1",
      hints: { readOnly: false, destructive: false },
      approved: null,
    };
    const { html } = view({ listed: [item], approvals: [], blocks: [] }, [
      { name: "search", status: "pending" },
    ]);
    expect(html).toContain("Voir la définition");
    expect(html).toContain("UniqueField");
    expect(html).not.toContain("Définition approuvée");
  });

  it("labels the hints a server declares about a tool as its own, and shows none it did not", () => {
    const { html } = view(
      {
        listed: [
          {
            name: "read",
            fingerprint: "r",
            definition: { annotations: { readOnlyHint: true, destructiveHint: false } },
          },
          {
            name: "wipe",
            fingerprint: "w",
            definition: { annotations: { destructiveHint: true } },
          },
          { name: "plain", fingerprint: "p", definition: { annotations: { readOnlyHint: "yes" } } },
        ],
        approvals: [],
        blocks: [],
      },
      ["read", "wipe", "plain"].map((name) => ({ name, status: "pending" as const })),
    );
    const card = (name: string) => {
      const from = html.indexOf(`data-testid="tool-review-${name}"`);
      return html.slice(from, html.indexOf("</li>", from));
    };
    expect(card("read")).toContain("Lecture seule selon le serveur");
    expect(card("read")).not.toContain("Destructif selon le serveur");
    expect(card("wipe")).toContain("Destructif selon le serveur");
    expect(card("plain")).not.toContain("selon le serveur");
  });

  it("lists a pending tool no listing carries, with the way to read the server and nothing to approve", () => {
    const { html, ids } = view(empty, [{ name: "ghost", status: "pending" }]);
    expect(html).toContain('data-testid="tool-review-ghost"');
    expect(html).toContain("Relire le serveur");
    expect(html).not.toContain('aria-label="Approuver ghost"');
    expect(html).toContain('aria-label="Bloquer ghost"');
    expect(ids("ghost")).not.toContain("approve");
  });

  it("explains a definition too large to keep", () => {
    const { html } = view(
      { listed: [{ name: "big", fingerprint: "x", definition: null }], approvals: [], blocks: [] },
      [{ name: "big", status: "pending" }],
    );
    expect(html).toContain("Définition trop volumineuse, non conservée");
  });

  it("says when nothing waits, and keeps the review loading until the policy is read", () => {
    expect(view(empty, [{ name: "export", status: "blocked" }]).html).toContain(
      "Aucun outil à examiner",
    );
    const loading = view(null, [{ name: "export", status: "pending" }]).html;
    expect(loading).not.toContain("Aucun outil à examiner");
    expect(loading).not.toContain('data-testid="tool-review-export"');
  });

  const waiting = (count: number) => ({
    policy: {
      listed: Array.from({ length: count }, (_, i) => ({
        name: `tool_${i}`,
        fingerprint: `fp${i}`,
        definition: { description: `Tool ${i}` },
      })),
      approvals: [],
      blocks: [],
    },
    tools: Array.from({ length: count }, (_, i) => ({
      name: `tool_${i}`,
      status: "pending" as const,
    })),
  });
  const closed = (html: string) => html.match(/aria-expanded="false"/g)?.length ?? 0;

  it("opens every definition up to three cards, none beyond unless it is a changed one", () => {
    const few = waiting(3);
    expect(closed(view(few.policy, few.tools).html)).toBe(0);
    const many = waiting(4);
    expect(closed(view(many.policy, many.tools).html)).toBe(4);
    const changed = {
      ...many.policy,
      approvals: [approval("tool_0", "old", { description: "Before" })],
    };
    expect(closed(view(changed, many.tools).html)).toBe(3);
  });

  it("offers « Approuver tout » from two approvable tools, with one confirmed body", () => {
    const two = waiting(2);
    expect(view(two.policy, two.tools).html).toContain('data-testid="tool-approve-all"');
    const one = waiting(1);
    expect(view(one.policy, one.tools).html).not.toContain('data-testid="tool-approve-all"');
    expect(view(two.policy, two.tools, { review: false }).html).not.toContain("tool-approve-all");
  });

  it("spins and locks only the clicked tool, its card buttons and its row", () => {
    const two = waiting(2);
    const { html, controls } = view(two.policy, two.tools, {
      pending: (action, name) => action === "approve" && name === "tool_0",
    });
    const button = (label: string) =>
      new RegExp(`<button[^>]*aria-label="${label}"[^>]*>(?:(?!</button>).)*</button>`, "s").exec(
        html,
      )?.[0] ?? "";
    expect(button("Approuver tool_0")).toContain("animate-spin");
    expect(button("Approuver tool_0")).toContain('disabled=""');
    expect(button("Bloquer tool_0")).not.toContain("animate-spin");
    expect(button("Bloquer tool_0")).toContain('disabled=""');
    for (const label of ["Approuver tool_1", "Bloquer tool_1"]) {
      expect(button(label)).not.toContain('disabled=""');
    }
    expect(controls.isBusy("tool_0")).toBe(true);
    expect(controls.isBusy("tool_1")).toBe(false);
  });
});

describe("ToolPolicyView row actions", () => {
  const policy: ToolPolicy = {
    listed: [
      { name: "waiting", fingerprint: "w", definition: {} },
      { name: "twice", fingerprint: "t1", definition: {} },
      { name: "twice", fingerprint: "t2", definition: {} },
    ],
    approvals: [approval("approved", "p")],
    blocks: [blocked("shut"), blocked("gone")],
  };
  const tools: Row[] = [
    { name: "waiting", status: "pending", origin: "listed" },
    { name: "twice", status: "pending", origin: "listed" },
    { name: "approved", status: "available", origin: "approved" },
    { name: "shut", status: "blocked", origin: "listed" },
    { name: "plain", status: "available", origin: "declared" },
  ];

  it("offers each tool the deeds its state allows", () => {
    const { ids } = view(policy, tools);
    expect(ids("waiting")).toEqual(["approve", "block"]);
    // Two listed definitions: approving one blind is ambiguous, the cards carry the diff.
    expect(ids("twice")).toEqual(["block"]);
    expect(ids("approved")).toEqual(["revoke", "block"]);
    expect(ids("shut")).toEqual(["unblock"]);
    expect(ids("plain")).toEqual(["block"]);
  });

  it("draws the withdrawal and the block as destructive deeds", () => {
    const { controls } = view(policy, tools);
    const destructive = (name: string) =>
      controls
        .rowActions({ name })
        .filter((action) => action.destructive)
        .map((action) => action.id);
    expect(destructive("approved")).toEqual(["revoke", "block"]);
    expect(destructive("waiting")).toEqual(["block"]);
  });

  it("keeps a block the catalog no longer carries as a row to unblock", () => {
    const { controls, ids } = view(policy, tools);
    expect(controls.extraRows).toEqual([{ name: "gone", status: "blocked" }]);
    expect(ids("gone")).toEqual(["unblock"]);
  });

  it("approves the one definition a row waits on, and unblocks by name", () => {
    const approved: unknown[] = [];
    const unblocked: string[] = [];
    const { controls } = view(policy, tools, {
      onApprove: (items) => approved.push(items),
      onUnblock: (name) => unblocked.push(name),
    });
    controls.rowActions({ name: "waiting" })[0]!.onSelect?.();
    controls.rowActions({ name: "shut" })[0]!.onSelect?.();
    expect(approved).toEqual([[{ name: "waiting", fingerprint: "w" }]]);
    expect(unblocked).toEqual(["shut"]);
  });

  it("locks a busy row's deeds", () => {
    const { controls } = view(policy, tools, { pending: (_, name) => name === "waiting" });
    expect(controls.rowActions({ name: "waiting" }).every((action) => action.disabled)).toBe(true);
    expect(controls.rowActions({ name: "plain" }).some((action) => action.disabled)).toBe(false);
  });

  it("offers no decision to a reader who cannot configure, nor before the policy is read", () => {
    expect(view(policy, tools, { review: false }).ids("waiting")).toEqual([]);
    expect(view(null, tools).ids("waiting")).toEqual([]);
  });
});

describe("ToolPolicyView declaration", () => {
  const catalog: Row[] = [
    { name: "search", status: "pending", origin: "listed" },
    { name: "open", status: "available", origin: "listed" },
    { name: "mine", status: "available", origin: "declared" },
    { name: "gone", status: "missing", origin: "approved" },
  ];
  const declaration = (declared: string[] = []) => {
    const calls: string[][] = [];
    const value: ToolDeclaration = {
      declared: new Set(declared),
      declare: (names) => calls.push(names),
    };
    return { value, calls };
  };
  const declareIds = (ids: (name: string) => string[], names: string[]) =>
    names.filter((name) => ids(name).includes("declare"));

  it("offers to declare reviewed and unreviewed listed tools, never the declared ones nor the missing ones", () => {
    const { ids } = view(empty, catalog, { declaration: declaration().value });
    expect(declareIds(ids, ["search", "open", "mine", "gone"])).toEqual(["search", "open"]);
  });

  it("declares one tool, or every listed one from the list menu", () => {
    const { value, calls } = declaration();
    const { controls } = view(empty, catalog, { declaration: value });
    controls
      .rowActions({ name: "open" })
      .find((action) => action.id === "declare")
      ?.onSelect?.();
    controls.listActions[0]!.onSelect?.();
    expect(calls).toEqual([["open"], ["search", "open"]]);
    expect(controls.listActions[0]!.testId).toBe("tool-declare-all");
  });

  it("drops a declared tool's deed, and the list deed when none remains", () => {
    const { ids, controls } = view(empty, catalog, {
      declaration: declaration(["search", "open"]).value,
    });
    expect(declareIds(ids, ["search", "open"])).toEqual([]);
    expect(controls.listActions).toEqual([]);
  });

  it("offers nothing to declare without a declaration", () => {
    const { ids, controls } = view(empty, catalog);
    expect(declareIds(ids, ["search", "open"])).toEqual([]);
    expect(controls.listActions).toEqual([]);
  });

  it("keeps the declarations and drops the decisions for a reader who cannot configure", () => {
    const { html, ids } = view(empty, catalog, { review: false, declaration: declaration().value });
    expect(ids("search")).toEqual(["declare"]);
    expect(html).not.toContain('data-testid="tool-review-search"');
    expect(html).not.toContain('aria-label="Approuver ');
  });
});

describe("IntegrationToolPolicySection", () => {
  const table = (controls: ToolPolicyControls) => (
    <p data-testid="table">{controls.rowActions({ name: "export_notes" }).length}</p>
  );
  const tools = [{ name: "export_notes", status: "pending" as const, origin: "listed" as const }];

  it("draws the table alone without access", () => {
    const html = render(
      <IntegrationToolPolicySection tools={tools}>{table}</IntegrationToolPolicySection>,
    );
    expect(html).toContain('<p data-testid="table">0</p>');
    expect(html).not.toContain("integration-tool-policy");
  });

  it("frames the table with the banner, and loads the review of a reader who may configure", () => {
    const html = render(
      <IntegrationToolPolicySection
        access={{ packageId: "@acme/crm", review: true, banner: <i data-testid="banner" /> }}
        tools={tools}
      >
        {table}
      </IntegrationToolPolicySection>,
    );
    expect(html.indexOf('data-testid="banner"')).toBeLessThan(html.indexOf('data-testid="table"'));
    expect(html).toContain("Outils à examiner");
  });
});
