// SPDX-License-Identifier: Apache-2.0

/**
 * The share editor sends the WHOLE replacement set (`shared_space_ids`), so each control must
 * add or drop exactly one space and keep the rest: the owner's multi-select over the org's
 * spaces, a space-scoped row's single toggle, and a governor's "remove from this space" (the
 * projection it reads, `[here]`, minus here: `[]`). Plus which control each grant renders, and
 * the scope badge.
 */

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../../api/client.ts";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { ConnectionShareEditor } from "../connection-share-editor.tsx";
import { ConnectionScopeBadge } from "../connection-scope-badge.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const ORG = "org_1";
const CONN = "11111111-1111-4111-8111-111111111111";
const HERE = "spc_here";

type Props = Parameters<typeof ConnectionShareEditor>[0];

const base: Props = {
  connectionId: CONN,
  orgId: ORG,
  scope: "org",
  sharedSpaceIds: [],
  ownSpaceId: null,
  hereSpaceId: HERE,
  canEditShares: true,
  canUnshareHere: false,
  lockHint: null,
  pending: false,
  onChange: () => {},
};

// Fixtures, not wire-complete rows: the editor reads only these fields.
const SPACES = [
  { id: HERE, name: "Ici", access: "member", personal: false },
  { id: "spc_other", name: "Ailleurs", access: "member", personal: false },
  { id: "spc_closed", name: "Fermé", access: "none", personal: false },
  { id: "spc_mine", name: "Personnel", access: "member", personal: true },
];

function seeded(): QueryClient {
  const qc = new QueryClient();
  const key = $api.queryOptions("get", "/api/spaces", {
    params: { header: { "X-Org-Id": ORG } },
  }).queryKey;
  qc.setQueryData(key, { object: "list", data: SPACES, hasMore: false });
  return qc;
}

function EditorProbe({ props, onTree }: { props: Props; onTree: (tree: ReactNode) => void }) {
  onTree(ConnectionShareEditor(props));
  return null;
}

/** The editor's element tree — the popover's items are a portal a static render drops. */
function treeOf(props: Props): ReactNode {
  const trees: ReactNode[] = [];
  render(<EditorProbe props={props} onTree={(t) => trees.push(t)} />, { queryClient: seeded() });
  return trees[0];
}

function propsOf(node: ReactNode, testId: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, testId);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (node.props["data-testid"] === testId) return node.props;
  return propsOf(node.props.children as ReactNode, testId);
}

/** What one control sends. */
function sent(props: Partial<Props>, testId: string, fire: (p: Record<string, unknown>) => void) {
  const writes: string[][] = [];
  const control = propsOf(
    treeOf({ ...base, ...props, onChange: (ids) => writes.push(ids) }),
    testId,
  );
  if (!control) throw new Error(`no control ${testId}`);
  fire(control);
  return writes;
}

const select = (p: Record<string, unknown>) => (p.onSelect as () => void)();
const target = (id: string) => `share-target-${CONN}-${id}`;

describe("ConnectionShareEditor — the owner's org-scoped row", () => {
  it("adds a space to the set, keeping the others", () => {
    expect(sent({ sharedSpaceIds: [HERE] }, target("spc_other"), select)).toEqual([
      [HERE, "spc_other"],
    ]);
  });

  it("removes only that space", () => {
    expect(sent({ sharedSpaceIds: [HERE, "spc_other"] }, target(HERE), select)).toEqual([
      ["spc_other"],
    ]);
  });

  it("offers only the spaces the owner reaches", () => {
    const tree = treeOf(base);
    expect(propsOf(tree, target(HERE))).toBeDefined();
    expect(propsOf(tree, target("spc_mine"))).toBeDefined();
    expect(propsOf(tree, target("spc_closed"))).toBeUndefined();
  });

  it("leaves removing this space enabled under a lock: the API answers 409", () => {
    const tree = treeOf({ ...base, sharedSpaceIds: [HERE], lockHint: "épinglée" });
    expect(propsOf(tree, target(HERE))?.disabled).toBe(false);
  });

  it("renders the multi-select trigger with the count", () => {
    const html = render(<ConnectionShareEditor {...base} sharedSpaceIds={[HERE, "spc_other"]} />, {
      queryClient: seeded(),
    });
    expect(html).toContain(`share-editor-${CONN}`);
    expect(html).toContain(i18n.t("settings:integration.connection.share.count", { count: 2 }));
  });
});

describe("ConnectionShareEditor — the owner's space-scoped row", () => {
  const space: Partial<Props> = { scope: "space", ownSpaceId: HERE };
  const toggle = (checked: boolean) => (p: Record<string, unknown>) =>
    (p.onChange as (e: unknown) => void)({ target: { checked } });

  it("offers one toggle, for its own space only", () => {
    const html = render(<ConnectionShareEditor {...base} {...space} />, { queryClient: seeded() });
    expect(html).toContain(`share-toggle-${CONN}`);
    expect(html).not.toContain(`share-editor-${CONN}`);
    expect(html).toContain(i18n.t("settings:integration.connection.share.thisSpace"));
  });

  it("shares into and out of its space", () => {
    expect(sent(space, `share-toggle-${CONN}`, toggle(true))).toEqual([[HERE]]);
    expect(
      sent({ ...space, sharedSpaceIds: [HERE] }, `share-toggle-${CONN}`, toggle(false)),
    ).toEqual([[]]);
  });
});

describe("ConnectionShareEditor — a governor on a colleague's row", () => {
  const governor: Partial<Props> = {
    canEditShares: false,
    canUnshareHere: true,
    sharedSpaceIds: [HERE],
  };

  it("removes the row from this space: the projection minus here", () => {
    const click = (p: Record<string, unknown>) => (p.onClick as () => void)();
    expect(sent(governor, `share-remove-here-${CONN}`, click)).toEqual([[]]);
  });

  it("offers no share targets", () => {
    const html = render(<ConnectionShareEditor {...base} {...governor} />, {
      queryClient: seeded(),
    });
    expect(html).toContain(`share-remove-here-${CONN}`);
    expect(html).not.toContain(`share-editor-${CONN}`);
    expect(html).not.toContain(`share-toggle-${CONN}`);
  });

  it("is disabled while a pin or the default names the row here", () => {
    const tree = treeOf({ ...base, ...governor, lockHint: "épinglée" });
    expect(propsOf(tree, `share-remove-here-${CONN}`)?.disabled).toBe(true);
  });
});

describe("ConnectionShareEditor — a plain member", () => {
  it("reads whether the row is shared here, and edits nothing", () => {
    const html = render(
      <ConnectionShareEditor {...base} canEditShares={false} sharedSpaceIds={[HERE]} />,
      { queryClient: seeded() },
    );
    expect(html).toContain(i18n.t("settings:integration.connection.share.sharedHere"));
    expect(html).not.toContain(`share-remove-here-${CONN}`);
  });
});

describe("ConnectionScopeBadge", () => {
  it("names the scope and carries its explanation for a screen reader", () => {
    const org = render(<ConnectionScopeBadge scope="org" />);
    expect(org).toContain("Toute l'organisation");
    expect(org).toContain(i18n.t("settings:integration.connection.scope.orgHelp"));
    const space = render(<ConnectionScopeBadge scope="space" />);
    expect(space).toContain("Cet espace uniquement");
    expect(space).toContain(i18n.t("settings:integration.connection.scope.spaceHelp"));
  });
});
