// SPDX-License-Identifier: Apache-2.0

/** What the responsive menus (`DropdownMenu`, `Popover`) do to a call site's props on a phone. */

import { type AnchoredKey, splitAnchoring } from "./primitive-props.ts";

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
