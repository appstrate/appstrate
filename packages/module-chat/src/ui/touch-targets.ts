// SPDX-License-Identifier: Apache-2.0

/** Touch sizes apply in portrait and landscape. See the desktop-pointer variant in styles.css. */
export const COMPOSER_BUTTON_CLASS = "size-10 shrink-0 rounded-lg desktop-pointer:size-8";
export const COMPOSER_TOOL_BUTTON_CLASS =
  "text-muted-foreground size-10 shrink-0 rounded-lg desktop-pointer:size-8";

/** Copy is visible on touch devices and when its button receives keyboard focus. */
export const ACTION_BAR_CLASS =
  "flex items-center gap-1 transition-opacity desktop-pointer:opacity-0 desktop-pointer:group-hover:opacity-100 desktop-pointer:focus-within:opacity-100";

export const ACTION_ROW_CLASS = "mt-1 flex h-10 items-center gap-2 desktop-pointer:h-7";
export const ICON_BUTTON_CLASS =
  "text-muted-foreground size-10 desktop-pointer:size-7 [&_svg]:size-3.5";
export const QUEUE_ICON_BUTTON_CLASS = "size-10 desktop-pointer:size-6";

/** Copy under the user's own message: always there on touch, revealed by hover or focus under a mouse. */
export const USER_ACTION_BAR_CLASS = `mt-0.5 h-10 justify-end desktop-pointer:h-7 ${ACTION_BAR_CLASS}`;

/** Reserve the button's real box so a tap cannot remove a chip from its neighboring action. */
export const CHIP_REMOVE_CLASS = "flex size-10 shrink-0 items-center justify-center";
