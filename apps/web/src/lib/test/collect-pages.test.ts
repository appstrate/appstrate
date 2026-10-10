// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { collectAllPages } from "../collect-pages.ts";

describe("collectAllPages", () => {
  it("follows hasMore, asking each page for the offset of the items already held", async () => {
    const pages = [
      { data: ["a", "b"], hasMore: true },
      { data: ["c"], hasMore: false },
    ];
    const offsets: number[] = [];
    const items = await collectAllPages(async (offset) => {
      offsets.push(offset);
      return pages.shift() ?? { data: [], hasMore: false };
    });
    expect(items).toEqual(["a", "b", "c"]);
    expect(offsets).toEqual([0, 2]);
  });

  it("stops on an empty page even when hasMore is set, so a server bug cannot loop forever", async () => {
    let calls = 0;
    const items = await collectAllPages(async () => {
      calls += 1;
      return { data: [], hasMore: true };
    });
    expect(items).toEqual([]);
    expect(calls).toBe(1);
  });
});
