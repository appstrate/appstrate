// SPDX-License-Identifier: Apache-2.0

/**
 * The two button treatments a list bar has, so every screen uses the same two.
 *
 * The SURFACE is what separates them, and that is the whole rule: a control
 * that adjusts the view is an outline on the canvas, a control that acts on the
 * data keeps a surface. Reading a bar left to right you can tell a setting from
 * a deed without reading a word.
 *
 * Both start from `variant="outline"`; the utility one takes its fill and its
 * shadow back off. `px-2.5 gap-1.5` is what shadcn's `size="sm"` resolves to for
 * a button carrying an icon (`has-[>svg]:px-2.5`) — ours is a flat `px-3 gap-2`,
 * which is where the extra width inside every one of them came from.
 */

/** Filters, Columns: adjusts what you are looking at. */
export const TOOLBAR_UTILITY = "h-8 gap-1.5 bg-transparent px-2.5 shadow-none";

/** What the screen does: create, import, mark as read. Keeps a surface. */
export const TOOLBAR_ACTION = "h-8 gap-1.5 px-2.5";
