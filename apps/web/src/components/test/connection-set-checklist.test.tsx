// SPDX-License-Identifier: Apache-2.0

/**
 * The one connection checklist, and its one encoding of "no connection": unticking the last
 * box is no choice at this layer (`null`); only the explicit "none" box writes none (`[]`).
 */

import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import type { ConnectionSet } from "../../lib/connection-set.ts";
import { ConnectionSetChecklist } from "../integration-detail/connection-set-checklist.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

type Props = Parameters<typeof ConnectionSetChecklist>[0];
interface Box {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const OPTIONS = [
  { id: "a", label: "A" },
  { id: "b", label: "B", disabled: true },
];

/** Renders the checklist inside a probe so its hooks run, and hands out its element tree. */
function ChecklistProbe({ props, onTree }: { props: Props; onTree: (tree: ReactNode) => void }) {
  onTree(ConnectionSetChecklist(props));
  return null;
}

/** The checklist's boxes by id, each with the handler a click would call, and what it wrote. */
function checklist(props: Partial<Props> & Pick<Props, "value">) {
  const written: ConnectionSet[] = [];
  const trees: ReactNode[] = [];
  const full: Props = {
    options: OPTIONS,
    idPrefix: "c",
    onChange: (n) => written.push(n),
    ...props,
  };
  render(<ChecklistProbe props={full} onTree={(tree) => trees.push(tree)} />);
  const boxes = new Map<string, Box>();
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (isValidElement<Record<string, unknown>>(node)) {
      const { id, onCheckedChange, children } = node.props;
      if (typeof id === "string" && typeof onCheckedChange === "function") {
        boxes.set(id, node.props as unknown as Box);
      }
      walk(children as ReactNode);
    }
  };
  walk(trees[0]);
  const box = (id: string): Box => {
    const found = boxes.get(id);
    if (!found) throw new Error(`no box ${id}`);
    return found;
  };
  return { boxes, box, written };
}

describe("ConnectionSetChecklist — encoding of 'no connection'", () => {
  it("unticking the last box is no choice, never none", () => {
    const { box, written } = checklist({ value: ["a"] });
    box("c-a").onCheckedChange(false);
    expect(written).toEqual([null]);
  });

  it("unticking one of several keeps the rest", () => {
    const { box, written } = checklist({ value: ["a", "b"] });
    box("c-a").onCheckedChange(false);
    expect(written).toEqual([["b"]]);
  });

  it("only the explicit none box writes none, and unticking it is no choice", () => {
    const unset = checklist({ value: null, allowNone: true });
    expect(unset.box("c-none").checked).toBe(false);
    unset.box("c-none").onCheckedChange(true);
    expect(unset.written).toEqual([[]]);

    const none = checklist({ value: [], allowNone: true });
    expect(none.box("c-none").checked).toBe(true);
    none.box("c-none").onCheckedChange(false);
    expect(none.written).toEqual([null]);
  });

  it("ticking a connection over none replaces it", () => {
    const { box, written } = checklist({ value: [], allowNone: true });
    expect(box("c-a").checked).toBe(false);
    box("c-a").onCheckedChange(true);
    expect(written).toEqual([["a"]]);
  });

  it("offers no none box without allowNone", () => {
    expect(checklist({ value: [] }).boxes.has("c-none")).toBe(false);
  });

  it("a disabled option refuses a tick, but a ticked one can still be unticked", () => {
    expect(checklist({ value: null }).box("c-b").disabled).toBe(true);
    expect(checklist({ value: ["b"] }).box("c-b").disabled).toBe(false);
  });

  it("reads out the none box's state as a checkbox", () => {
    const html = (value: ConnectionSet) =>
      render(
        <ConnectionSetChecklist
          options={OPTIONS}
          value={value}
          onChange={() => {}}
          idPrefix="c"
          allowNone
        />,
      ).match(/<button[^>]*id="c-none"[^>]*>/)![0];
    expect(html([])).toContain('role="checkbox"');
    expect(html([])).toContain('aria-checked="true"');
    expect(html(null)).toContain('aria-checked="false"');
  });
});
