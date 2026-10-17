// SPDX-License-Identifier: Apache-2.0

/**
 * Reads the controls of a component without a DOM: a test walks its element tree, expanding
 * every function component it meets, and keeps each element carrying a `data-testid` with its
 * props (the handlers included). Call it inside a component render (they use hooks).
 */

import { isValidElement, type ReactNode } from "react";

export type MenuItem = Record<string, unknown> & {
  disabled?: boolean;
  onSelect?: (e: { preventDefault: () => void }) => void;
};

/** Every element carrying a `data-testid`, by test id, with its props; an inner one wins. */
export function menuItems(root: ReactNode): Map<string, MenuItem> {
  const items = new Map<string, MenuItem>();
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement<Record<string, unknown>>(node)) return;
    // A component of ours is read through what it renders; library primitives (forwardRef
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
