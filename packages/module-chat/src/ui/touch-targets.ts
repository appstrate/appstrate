// SPDX-License-Identifier: Apache-2.0

/**
 * Touch sizes apply in portrait and landscape. See the desktop-pointer variant in styles.css.
 * An icon `Button` takes its touch size (44 px) from `size="icon-sm"`: these classes only carry
 * what that size does not, so they must never set a touch size of their own.
 */
export const COMPOSER_BUTTON_CLASS = "shrink-0 rounded-lg";

/** Copy is visible on touch devices and when its button receives keyboard focus. */
export const ACTION_BAR_CLASS =
  "flex items-center gap-1 transition-opacity desktop-pointer:opacity-0 desktop-pointer:group-hover:opacity-100 desktop-pointer:focus-within:opacity-100";

export const ACTION_ROW_CLASS = "mt-1 flex h-11 items-center gap-2 desktop-pointer:h-7";
export const ICON_BUTTON_CLASS = "text-muted-foreground desktop-pointer:size-7 [&_svg]:size-3.5";

/** Copy under the user's own message: always there on touch, revealed by hover or focus under a mouse. */
export const USER_ACTION_BAR_CLASS = `mt-0.5 h-11 justify-end desktop-pointer:h-7 ${ACTION_BAR_CLASS}`;

/** Reserve the button's real box so a tap cannot remove a chip from its neighboring action. */
export const CHIP_REMOVE_CLASS = "flex size-10 shrink-0 items-center justify-center";

/** A thread disclosure's `size="sm"` ghost trigger: 40 px on touch, 36 px under a mouse. */
export const DISCLOSURE_TRIGGER_CLASS =
  "text-muted-foreground hover:text-foreground group -ml-2 h-10 gap-1.5 px-2 desktop-pointer:h-9";
