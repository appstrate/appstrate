// SPDX-License-Identifier: Apache-2.0

/**
 * The layout of a configuration's row (Settings › Models, Preferences › Models) and of its
 * skeleton. In a narrow container (a phone) the label and summary keep the first line's width;
 * the state, the repair and the menus go under them, aligned on the text (the logo's `size-8`
 * plus the item's `gap-2.5`). From `@xl` of the row's own container (`@container/row`, on the
 * row's root), one line.
 */
export const MODEL_ROW_ITEM = "flex-wrap @xl/row:flex-nowrap";
// Wraps on a phone: a row to connect carries its state, the « Connecter » split button and the
// menus, wider together than a 375px line.
export const MODEL_ROW_ACTIONS =
  "w-full shrink-0 flex-wrap pl-[2.625rem] @xl/row:w-auto @xl/row:flex-nowrap @xl/row:pl-0";
/** The row's own menus, pushed to the end of the second line on a phone. */
export const MODEL_ROW_MENUS = "ml-auto flex items-center gap-2";
