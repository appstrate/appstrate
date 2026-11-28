// SPDX-License-Identifier: Apache-2.0

/** Prop shapes shared by the wrappers around Base UI parts. */

/**
 * A part's props with a plain-string `className`: Base UI also takes a function of the part's
 * state, which `cn()` cannot merge.
 */
export type WithClassName<P> = Omit<P, "className"> & { className?: string };

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

export type AnchoredKey = (typeof ANCHORED_PROPS)[number];

/**
 * A popup's props split in two: what its positioner takes, and the rest for the popup itself
 * (Base UI draws them as separate elements).
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
