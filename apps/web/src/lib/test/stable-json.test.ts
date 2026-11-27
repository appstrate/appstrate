// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { stableJson } from "../stable-json";

describe("stableJson", () => {
  it("ignores missing JSON values in objects and preserves array order", () => {
    expect(stableJson({ b: undefined, a: { c: 3, a: 2 } })).toBe(stableJson({ a: { a: 2, c: 3 } }));
    expect(stableJson([undefined, 2])).toBe(stableJson([null, 2]));
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
    expect(stableJson(undefined)).toBeUndefined();
    expect(() => stableJson(2n)).toThrow();
  });

  it("sorts keys at every depth, indented on request", () => {
    expect(stableJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }, 2)).toBe(
      stableJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }, 2),
    );
    const indented = stableJson({ b: 1, a: 2 }, 2) ?? "";
    expect(indented.indexOf('"a"')).toBeLessThan(indented.indexOf('"b"'));
    expect(indented).toContain("\n");
  });
});
