// SPDX-License-Identifier: Apache-2.0

/**
 * Reads the items of a connection choice menu without rendering it: a Radix menu draws its items
 * in a portal a static render drops, so a test walks the element tree instead, expanding every
 * function component it meets. Call it inside a component render (they use hooks).
 */

import { isValidElement, type ReactNode } from "react";

export type MenuItem = Record<string, unknown> & {
  disabled?: boolean;
  onSelect?: (e: { preventDefault: () => void }) => void;
};

/** Every element carrying a `data-testid`, by test id, with its props. */
export function menuItems(root: ReactNode): Map<string, MenuItem> {
  const items = new Map<string, MenuItem>();
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement<Record<string, unknown>>(node)) return;
    // A component of ours is read through what it renders; the menu's own primitives (forwardRef
    // objects) are read through their children.
    if (typeof node.type === "function") {
      return walk((node.type as (props: unknown) => ReactNode)(node.props));
    }
    const id = node.props["data-testid"];
    if (typeof id === "string") items.set(id, node.props);
    walk(node.props.children as ReactNode);
  };
  walk(root);
  return items;
}

/** Every string rendered literally in an element tree. */
export function textsOf(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(textsOf);
  if (!isValidElement<{ children?: unknown }>(node)) return [];
  return textsOf(node.props.children);
}

/** The `description` a choice's label carries: the line that says what the choice means. */
export function descriptionOf(node: unknown): string | undefined {
  if (Array.isArray(node)) return node.map(descriptionOf).find((d) => d !== undefined);
  if (!isValidElement<{ description?: unknown; children?: unknown }>(node)) return undefined;
  if (typeof node.props.description === "string") return node.props.description;
  return descriptionOf(node.props.children);
}
