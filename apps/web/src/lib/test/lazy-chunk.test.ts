// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { chunk } from "../lazy-chunk";

describe("chunk", () => {
  it("downloads once: a preload and the first render share the same import", async () => {
    let calls = 0;
    const source = chunk(async () => {
      calls++;
      return { value: 1 };
    });
    const [first, second] = await Promise.all([source.load(), source.load()]);
    expect(first).toBe(second);
    expect(await source.load()).toBe(first);
    expect(calls).toBe(1);
  });

  it("retries after a failed download instead of caching the failure", async () => {
    let calls = 0;
    const source = chunk(async () => {
      calls++;
      if (calls === 1) throw new Error("stale chunk");
      return { value: 2 };
    });
    expect(source.load()).rejects.toThrow("stale chunk");
    await Bun.sleep(0);
    expect(await source.load()).toEqual({ value: 2 });
    expect(calls).toBe(2);
  });
});
