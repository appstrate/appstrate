// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { formatBytes, formatDuration } from "../src/format.ts";

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

describe("formatBytes", () => {
  it("keeps the English form when no locale is given", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(5.2 * 1024 * 1024)).toBe("5.2 MB");
    expect(formatBytes(100 * 1024 ** 3)).toBe("100 GB");
    expect(formatBytes(4096 * 1024 ** 3)).toBe("4096 GB");
  });

  it("falls back to a raw count for a malformed input", () => {
    expect(formatBytes(-1)).toBe("-1 B");
    expect(formatBytes(Number.NaN)).toBe("NaN B");
  });

  it("counts in octets with a decimal comma in French", () => {
    expect(formatBytes(512, "fr")).toBe("512 o");
    expect(formatBytes(2048, "fr")).toBe("2,0 Ko");
    expect(formatBytes(1024 * 1024, "fr-FR")).toBe("1,0 Mo");
    expect(formatBytes(12 * 1024 ** 3, "fr")).toBe("12 Go");
  });

  it("keeps the English units for another locale", () => {
    expect(formatBytes(2048, "en")).toBe("2.0 KB");
  });

  it("renders the English form for a malformed locale tag instead of throwing", () => {
    expect(formatBytes(2048, "fr_FR")).toBe("2.0 KB");
    expect(formatBytes(512, "fr_FR")).toBe("512 B");
    expect(formatBytes(2048, "")).toBe("2.0 KB");
  });
});
