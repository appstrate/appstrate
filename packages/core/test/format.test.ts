// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { formatDuration } from "../src/format.ts";

describe("formatDuration", () => {
  it("renders sub-second values as rounded milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(8)).toBe("8ms");
    expect(formatDuration(999.6)).toBe("1000ms");
  });

  it("renders under a minute as one-decimal seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(2657)).toBe("2.7s");
    expect(formatDuration(59_900)).toBe("59.9s");
  });

  it("renders a minute or more as <m>m <s>s", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("clamps non-finite / negative to 0ms", () => {
    expect(formatDuration(-500)).toBe("0ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
  });
});
