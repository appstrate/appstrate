// SPDX-License-Identifier: Apache-2.0

// Both start from `variant="outline"`. `px-2.5 gap-1.5` is shadcn's `size="sm"` with an icon;
// ours is a flat `px-3 gap-2`, which would add width.

/** Adjusts the view (Filters, Columns): outline on the canvas, no surface. */
export const TOOLBAR_UTILITY = "h-8 gap-1.5 bg-transparent px-2.5 shadow-none";

/** Acts on the data (create, import): keeps a surface. */
export const TOOLBAR_ACTION = "h-8 gap-1.5 px-2.5";
