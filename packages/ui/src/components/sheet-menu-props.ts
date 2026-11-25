// SPDX-License-Identifier: Apache-2.0

/** What the responsive menus (`DropdownMenu`, `Popover`) do to a call site's props on a sheet. */

/**
 * The positioning props of a popover's or a dropdown's content: a bottom sheet has no anchor to
 * place itself against, so they are dropped there (and `loop`, the menu's arrow-key wrap).
 */
const ANCHORED_PROPS = [
  "side",
  "sideOffset",
  "align",
  "alignOffset",
  "avoidCollisions",
  "collisionBoundary",
  "collisionPadding",
  "arrowPadding",
  "sticky",
  "hideWhenDetached",
  "updatePositionStrategy",
  "loop",
] as const;

export function withoutAnchoring<P extends object>(
  props: P,
): Omit<P, (typeof ANCHORED_PROPS)[number]> {
  const rest = { ...props } as Record<string, unknown>;
  for (const key of ANCHORED_PROPS) delete rest[key];
  return rest as Omit<P, (typeof ANCHORED_PROPS)[number]>;
}

/**
 * What a trigger is called, read when it is pressed: the sheet's accessible name when the content
 * gives none.
 */
export function triggerName(trigger: HTMLElement): string {
  return trigger.getAttribute("aria-label") ?? trigger.textContent?.trim() ?? "";
}
