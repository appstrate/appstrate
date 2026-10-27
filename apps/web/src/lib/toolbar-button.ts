// SPDX-License-Identifier: Apache-2.0

// Outline treatments start from `variant="outline"`, the primary one from `variant="default"`.
// `h-8 px-2.5 gap-1.5` is shadcn's `size="sm"` tightened to the toolbar's 32px; the stock
// `h-9 px-3 gap-2` would put a taller button next to every one of these.
const TOOLBAR_SIZE = "h-8 gap-1.5 px-2.5";

/** Adjusts the view (Filters, Columns): outline on the canvas, no surface. */
export const TOOLBAR_UTILITY = "h-8 gap-1.5 bg-transparent px-2.5 shadow-none";

/** Acts on the data (create, import, run): keeps a surface. */
export const TOOLBAR_ACTION = `${TOOLBAR_SIZE} bg-card`;

/** The one filled deed of a bar (Activate): the toolbar's size, the variant's own fill. */
export const TOOLBAR_PRIMARY = TOOLBAR_SIZE;
