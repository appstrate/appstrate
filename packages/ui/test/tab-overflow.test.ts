// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { partitionTabs } from "../src/lib/tab-overflow.ts";

describe("partitionTabs", () => {
  it("keeps every tab visible when the row fits", () => {
    expect(
      partitionTabs({
        itemWidths: [100, 100, 100],
        containerWidth: 400,
        overflowWidth: 40,
        activeIndex: 0,
      }),
    ).toEqual({ visible: [0, 1, 2], hidden: [] });
  });

  it("does not reserve the overflow width when the row fits exactly", () => {
    // 300 of content in exactly 300 of container: reserving the 40px "…"
    // trigger here would collapse a bar that fits.
    expect(
      partitionTabs({
        itemWidths: [100, 100, 100],
        containerWidth: 300,
        overflowWidth: 40,
        activeIndex: 1,
      }),
    ).toEqual({ visible: [0, 1, 2], hidden: [] });
  });

  it("fills greedily from the left while reserving the overflow width", () => {
    // budget = 300 - 40 = 260 → two items fit, the third does not.
    expect(
      partitionTabs({
        itemWidths: [100, 100, 100, 100],
        containerWidth: 300,
        overflowWidth: 40,
        activeIndex: 0,
      }),
    ).toEqual({ visible: [0, 1], hidden: [2, 3] });
  });

  it("stops at the first item that does not fit instead of skipping it", () => {
    // budget = 260. The wide item at index 1 does not fit; index 2 would, but
    // taking it would leave a hole in the middle of the bar.
    expect(
      partitionTabs({
        itemWidths: [100, 400, 20, 20],
        containerWidth: 300,
        overflowWidth: 40,
        activeIndex: 0,
      }),
    ).toEqual({ visible: [0], hidden: [1, 2, 3] });
  });

  it("never hides the active tab, dropping trailing visible items to fit it", () => {
    // budget = 260 → greedy would show [0, 1] and hide the active index 5.
    // Both leading items are dropped so the 200px active one fits.
    expect(
      partitionTabs({
        itemWidths: [100, 100, 100, 100, 100, 200],
        containerWidth: 300,
        overflowWidth: 40,
        activeIndex: 5,
      }),
    ).toEqual({ visible: [5], hidden: [0, 1, 2, 3, 4] });
  });

  it("drops only as many trailing items as needed to fit the active tab", () => {
    // budget = 260 → greedy [0, 1]; dropping index 1 frees enough for index 4.
    expect(
      partitionTabs({
        itemWidths: [100, 100, 100, 100, 150],
        containerWidth: 300,
        overflowWidth: 40,
        activeIndex: 4,
      }),
    ).toEqual({ visible: [0, 4], hidden: [1, 2, 3] });
  });

  it("keeps visible indices in source order after protecting the active tab", () => {
    const { visible } = partitionTabs({
      itemWidths: [50, 50, 50, 50, 50, 50],
      containerWidth: 200,
      overflowWidth: 40,
      activeIndex: 5,
    });
    expect(visible).toEqual([...visible].sort((a, b) => a - b));
    expect(visible).toContain(5);
  });

  it("returns empty lists for zero items", () => {
    expect(
      partitionTabs({ itemWidths: [], containerWidth: 500, overflowWidth: 40, activeIndex: 0 }),
    ).toEqual({ visible: [], hidden: [] });
  });

  it("shows the full bar while the container is still unmeasured", () => {
    expect(
      partitionTabs({
        itemWidths: [100, 100, 100],
        containerWidth: 0,
        overflowWidth: 40,
        activeIndex: 2,
      }),
    ).toEqual({ visible: [0, 1, 2], hidden: [] });
  });

  it("shows a single item wider than the container when it is active", () => {
    expect(
      partitionTabs({ itemWidths: [500], containerWidth: 100, overflowWidth: 40, activeIndex: 0 }),
    ).toEqual({ visible: [0], hidden: [] });
  });

  it("collapses a single item wider than the container when nothing is active", () => {
    expect(
      partitionTabs({ itemWidths: [500], containerWidth: 100, overflowWidth: 40, activeIndex: -1 }),
    ).toEqual({ visible: [], hidden: [0] });
  });

  it("ignores an out-of-range active index", () => {
    const expected = { visible: [0, 1], hidden: [2, 3] };
    expect(
      partitionTabs({
        itemWidths: [100, 100, 100, 100],
        containerWidth: 300,
        overflowWidth: 40,
        activeIndex: -1,
      }),
    ).toEqual(expected);
    expect(
      partitionTabs({
        itemWidths: [100, 100, 100, 100],
        containerWidth: 300,
        overflowWidth: 40,
        activeIndex: 99,
      }),
    ).toEqual(expected);
  });

  it("tolerates an overflow trigger wider than the container", () => {
    expect(
      partitionTabs({
        itemWidths: [100, 100],
        containerWidth: 30,
        overflowWidth: 40,
        activeIndex: -1,
      }),
    ).toEqual({ visible: [], hidden: [0, 1] });
  });

  it("treats negative, NaN and infinite measurements as zero", () => {
    expect(
      partitionTabs({
        itemWidths: [Number.NaN, -50, 100],
        containerWidth: 120,
        overflowWidth: Number.POSITIVE_INFINITY,
        activeIndex: 2,
      }),
    ).toEqual({ visible: [0, 1, 2], hidden: [] });
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      itemWidths: [80, 120, 90, 140, 70],
      containerWidth: 320,
      overflowWidth: 36,
      activeIndex: 3,
    };
    expect(partitionTabs(input)).toEqual(partitionTabs(input));
  });

  it("does not mutate its input", () => {
    const itemWidths = [100, 100, 100, 100];
    partitionTabs({ itemWidths, containerWidth: 250, overflowWidth: 40, activeIndex: 3 });
    expect(itemWidths).toEqual([100, 100, 100, 100]);
  });
});
