// SPDX-License-Identifier: Apache-2.0

/**
 * The share editor reports one space per action: `onShare(spaceId)` or `onUnshare(spaceId)`. The
 * caller decides which controls a row gets from its `allowed_actions`, and the editor lists the
 * `targets` it is given without filtering them. Covered here: the owner's multi-select, a
 * space-scoped row's single toggle, a governor's "remove from this space", a plain member's read
 * only state, and the scope badge.
 */

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { ConnectionShareEditor } from "../connection-share-editor.tsx";
import { ConnectionScopeBadge } from "../connection-scope-badge.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const CONN = "11111111-1111-4111-8111-111111111111";
const HERE = "spc_here";

type Props = Parameters<typeof ConnectionShareEditor>[0];

const base: Props = {
  connectionId: CONN,
  scope: "org",
  rowSpaceId: null,
  hereSpaceId: HERE,
  targets: [
    { id: HERE, name: "Ici" },
    { id: "spc_other", name: "Ailleurs" },
  ],
  sharedSpaceIds: [],
  sharedHere: false,
  canShare: true,
  canUnshareHere: false,
  lockHint: null,
  pending: false,
  onShare: () => {},
  onUnshare: () => {},
};

function EditorProbe({ props, onTree }: { props: Props; onTree: (tree: ReactNode) => void }) {
  onTree(ConnectionShareEditor(props));
  return null;
}

/** The editor's element tree: the popover's items live in its children, which a static render drops. */
function treeOf(props: Props): ReactNode {
  const trees: ReactNode[] = [];
  render(<EditorProbe props={props} onTree={(t) => trees.push(t)} />);
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

/** The `data-testid` of every share target in the tree, in order. */
function targetTestIds(node: ReactNode): string[] {
  const ids: string[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement<Record<string, unknown>>(n)) return;
    const testId = n.props["data-testid"];
    if (typeof testId === "string" && testId.startsWith("share-target-")) ids.push(testId);
    walk(n.props.children as ReactNode);
  };
  walk(node);
  return ids;
}

/** What one control reports: the spaces it shares into and withdraws from. */
function actOn(props: Partial<Props>, testId: string, fire: (p: Record<string, unknown>) => void) {
  const shared: string[] = [];
  const unshared: string[] = [];
  const control = propsOf(
    treeOf({
      ...base,
      ...props,
      onShare: (id) => shared.push(id),
      onUnshare: (id) => unshared.push(id),
    }),
    testId,
  );
  if (!control) throw new Error(`no control ${testId}`);
  fire(control);
  return { shared, unshared };
}

const select = (p: Record<string, unknown>) => (p.onSelect as () => void)();
const target = (id: string) => `share-target-${CONN}-${id}`;

describe("ConnectionShareEditor — the owner's org-scoped row", () => {
  it("lists exactly the targets it is given", () => {
    const tree = treeOf({
      ...base,
      targets: [
        { id: "s1", name: "Un" },
        { id: "s2", name: "Deux" },
      ],
      sharedSpaceIds: ["s2"],
    });
    expect(targetTestIds(tree)).toEqual([target("s1"), target("s2")]);
  });

  it("shares into a space that is not yet in the set", () => {
    expect(actOn({ sharedSpaceIds: [] }, target("spc_other"), select)).toEqual({
      shared: ["spc_other"],
      unshared: [],
    });
  });

  it("withdraws a space that is already in the set", () => {
    expect(actOn({ sharedSpaceIds: [HERE] }, target(HERE), select)).toEqual({
      shared: [],
      unshared: [HERE],
    });
  });

  it("leaves removing a space enabled under a lock: the owner's edits ignore it", () => {
    const tree = treeOf({ ...base, sharedSpaceIds: [HERE], lockHint: "épinglée" });
    expect(propsOf(tree, target(HERE))?.disabled).toBe(false);
  });

  it("renders the multi-select trigger with the count", () => {
    const html = render(<ConnectionShareEditor {...base} sharedSpaceIds={[HERE, "spc_other"]} />);
    expect(html).toContain(`share-editor-${CONN}`);
    expect(html).toContain(i18n.t("settings:integration.connection.share.count", { count: 2 }));
  });
});

describe("ConnectionShareEditor — the owner's space-scoped row", () => {
  const space: Partial<Props> = { scope: "space", rowSpaceId: HERE };
  const toggle = (checked: boolean) => (p: Record<string, unknown>) =>
    (p.onChange as (e: unknown) => void)({ target: { checked } });

  it("offers one toggle, for its own space only", () => {
    const html = render(<ConnectionShareEditor {...base} {...space} />);
    expect(html).toContain(`share-toggle-${CONN}`);
    expect(html).not.toContain(`share-editor-${CONN}`);
    expect(html).toContain(i18n.t("settings:integration.connection.share.thisSpace"));
  });

  it("shares into and out of its space", () => {
    expect(actOn(space, `share-toggle-${CONN}`, toggle(true))).toEqual({
      shared: [HERE],
      unshared: [],
    });
    expect(
      actOn({ ...space, sharedSpaceIds: [HERE] }, `share-toggle-${CONN}`, toggle(false)),
    ).toEqual({ shared: [], unshared: [HERE] });
  });
});

describe("ConnectionShareEditor — a governor on a colleague's row", () => {
  const governor: Partial<Props> = {
    canShare: false,
    canUnshareHere: true,
    sharedHere: true,
  };

  it("removes the row from this space", () => {
    const click = (p: Record<string, unknown>) => (p.onClick as () => void)();
    expect(actOn(governor, `share-remove-here-${CONN}`, click)).toEqual({
      shared: [],
      unshared: [HERE],
    });
  });

  it("offers no share targets", () => {
    const html = render(<ConnectionShareEditor {...base} {...governor} />);
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
  it("reads that the row is shared here, and edits nothing", () => {
    const html = render(
      <ConnectionShareEditor {...base} canShare={false} canUnshareHere={false} sharedHere={true} />,
    );
    expect(html).toContain(i18n.t("settings:integration.connection.share.sharedHere"));
    expect(html).not.toContain(`share-remove-here-${CONN}`);
    expect(html).not.toContain(`share-editor-${CONN}`);
  });

  it("shows a dash when the row is not shared here", () => {
    const html = render(
      <ConnectionShareEditor
        {...base}
        canShare={false}
        canUnshareHere={false}
        sharedHere={false}
      />,
    );
    expect(html).toContain("—");
    expect(html).not.toContain(i18n.t("settings:integration.connection.share.sharedHere"));
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
