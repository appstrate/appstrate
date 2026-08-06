// SPDX-License-Identifier: Apache-2.0

/**
 * Priority+ arithmetic for a single-row tab strip.
 *
 * Kept free of React and of the DOM so it can be unit-tested: the package has
 * no DOM test environment, so every rule that matters lives here rather than
 * in the component.
 */

export interface PartitionTabsInput {
  /** Natural (untruncated) width of each trigger, in source order. */
  itemWidths: number[];
  /** Width available to the strip, excluding the pill's own padding. */
  containerWidth: number;
  /** Width of the "…" overflow trigger. */
  overflowWidth: number;
  /** Index of the active trigger, or -1 when nothing is active. */
  activeIndex: number;
}

export interface PartitionTabsResult {
  /** Indices to render in the bar, in source order. */
  visible: number[];
  /** Indices to render in the overflow menu, in source order. */
  hidden: number[];
}

/** Treat NaN / Infinity / negative measurements as 0 rather than propagating them. */
function sanitize(width: number): number {
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/**
 * Split tabs into the ones that fit on one row and the ones that collapse into
 * the overflow menu.
 *
 * Rules:
 *  - When everything fits, `overflowWidth` is NOT reserved — reserving it
 *    unconditionally would collapse a bar that fits exactly.
 *  - Otherwise fill greedily from the left, reserving `overflowWidth`. Filling
 *    stops at the first item that does not fit (rather than skipping it) so the
 *    bar never grows a hole in the middle.
 *  - The active tab is never hidden. If greedy filling would hide it, trailing
 *    visible items are dropped — the ones nearest to it — until it fits. A tab
 *    wider than the whole bar is still shown (and clipped), never hidden.
 *  - `visible` always stays in source order: the bar must not reorder itself as
 *    the user clicks around.
 *  - Degenerate input (no items, unmeasured container, out-of-range active
 *    index) returns the full bar rather than throwing.
 */
export function partitionTabs(input: PartitionTabsInput): PartitionTabsResult {
  const widths = input.itemWidths.map(sanitize);
  const count = widths.length;
  if (count === 0) return { visible: [], hidden: [] };

  const everything = (): PartitionTabsResult => ({
    visible: widths.map((_, index) => index),
    hidden: [],
  });

  // containerWidth 0 means "not measured yet" (first paint, before the
  // ResizeObserver has delivered anything). Show the full bar: a flash of the
  // complete strip is strictly better than a flash of a collapsed one.
  const containerWidth = sanitize(input.containerWidth);
  if (containerWidth === 0) return everything();

  let total = 0;
  for (const width of widths) total += width;
  if (total <= containerWidth) return everything();

  const budget = containerWidth - sanitize(input.overflowWidth);
  const visible: number[] = [];
  let used = 0;
  for (let index = 0; index < count; index++) {
    const next = used + (widths[index] ?? 0);
    if (next > budget) break;
    used = next;
    visible.push(index);
  }

  const { activeIndex } = input;
  const hasActive = Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < count;
  if (hasActive && !visible.includes(activeIndex)) {
    // Greedy filling took a prefix, so the active index sits after every
    // visible one: dropping from the tail and appending keeps source order.
    const activeWidth = widths[activeIndex] ?? 0;
    while (visible.length > 0 && used + activeWidth > budget) {
      used -= widths[visible.pop() ?? 0] ?? 0;
    }
    visible.push(activeIndex);
  }

  const shown = new Set(visible);
  const hidden: number[] = [];
  for (let index = 0; index < count; index++) {
    if (!shown.has(index)) hidden.push(index);
  }
  return { visible, hidden };
}
