// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's controls as a thumb meets them. Apple asks 44 pt, Material 48 dp, WCAG 2.2 AAA 44 px
 * (AA 24 px); a desktop pointer needs far less. Below `md` an icon button is 40 px (the composer
 * row has no room for 44: attach, settings, the limit chip and send must fit 343 px), and a
 * control too small to grow keeps its look and gains an invisible 40 px touch area. Nothing here
 * hides behind hover on a phone. `test/touch-targets.test.ts` holds the rule.
 */

/** Send, stop and queue. */
export const COMPOSER_BUTTON_CLASS = "size-8 shrink-0 rounded-lg max-md:size-10";

/** Attach and settings, left of the composer's row. */
export const COMPOSER_TOOL_BUTTON_CLASS =
  "text-muted-foreground size-8 shrink-0 rounded-lg max-md:size-10";

/** Copy under an answer: revealed by hover from `md`, always there on a phone. */
export const ACTION_BAR_CLASS =
  "flex items-center gap-1 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100";

/** The row holding the action bar: tall enough for the 40 px Copy on a phone. */
export const ACTION_ROW_CLASS = "mt-1 flex h-7 items-center gap-2 max-md:h-10";

/** The small ghost icon buttons of a message and of the queued messages. */
export const ICON_BUTTON_CLASS = "text-muted-foreground size-7 max-md:size-10 [&_svg]:size-3.5";
export const QUEUE_ICON_BUTTON_CLASS = "size-6 max-md:size-10";

/** A tiny control (a chip's X) keeps its size and gains a 36 px invisible touch area below md. */
export const TOUCH_AREA_CLASS =
  "relative max-md:before:absolute max-md:before:-inset-2.5 max-md:before:content-['']";
