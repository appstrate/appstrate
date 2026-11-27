// SPDX-License-Identifier: Apache-2.0

/** What the responsive menus (`DropdownMenu`, `Popover`) do to a call site's props. */

/** The props of an anchored popup's positioner: where it sits against its anchor. */
const ANCHORED_PROPS = [
  "side",
  "sideOffset",
  "align",
  "alignOffset",
  "anchor",
  "collisionAvoidance",
  "collisionBoundary",
  "collisionPadding",
  "arrowPadding",
  "sticky",
  "positionMethod",
  "disableAnchorTracking",
] as const;

type AnchoredKey = (typeof ANCHORED_PROPS)[number];

/**
 * A popup's props split in two: what its positioner takes, and the rest for the popup itself
 * (the Base UI parts are separate elements, where Radix's content took both).
 */
export function splitAnchoring<P extends object>(
  props: P,
): [Pick<P, Extract<keyof P, AnchoredKey>>, Omit<P, AnchoredKey>] {
  const anchoring: Record<string, unknown> = {};
  const rest = { ...props } as Record<string, unknown>;
  for (const key of ANCHORED_PROPS) {
    if (key in rest) {
      anchoring[key] = rest[key];
      delete rest[key];
    }
  }
  return [anchoring as Pick<P, Extract<keyof P, AnchoredKey>>, rest as Omit<P, AnchoredKey>];
}

/** A bottom sheet has no anchor to place itself against: the positioning props are dropped. */
export function withoutAnchoring<P extends object>(props: P): Omit<P, AnchoredKey> {
  return splitAnchoring(props)[1];
}

/**
 * What a trigger is called, read when it is pressed: the sheet's accessible name when the content
 * gives none.
 */
export function triggerName(trigger: HTMLElement): string {
  return trigger.getAttribute("aria-label") ?? trigger.textContent?.trim() ?? "";
}
