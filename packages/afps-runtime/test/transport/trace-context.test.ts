// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  nextTraceContext,
  parseTraceparent,
} from "../../src/transport/trace-context.ts";

describe("parseTraceparent", () => {
  it("accepts a well-formed v00 header", () => {
    const ctx = parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(ctx).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      flags: "01",
    });
  });

  it("trims whitespace before parsing", () => {
    const ctx = parseTraceparent("  00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00\n");
    expect(ctx?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("rejects unsupported versions", () => {
    expect(parseTraceparent("ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent("00-tooshort-tooshort-01")).toBeNull();
    expect(parseTraceparent("00-NOTHEX1916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBeNull();
  });

  it("rejects all-zero trace-id (W3C §3.2)", () => {
    expect(parseTraceparent("00-00000000000000000000000000000000-b7ad6b7169203331-01")).toBeNull();
  });

  it("rejects all-zero parent-id (W3C §3.2)", () => {
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01")).toBeNull();
  });

  it("returns null for null/undefined/empty", () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
  });
});

describe("formatTraceparent", () => {
  it("serialises a context to wire format", () => {
    expect(
      formatTraceparent({
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        flags: "01",
      }),
    ).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });

  it("round-trips with parseTraceparent", () => {
    const original = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00";
    const parsed = parseTraceparent(original);
    expect(parsed).not.toBeNull();
    expect(formatTraceparent(parsed!)).toBe(original);
  });
});

describe("generateTraceId / generateSpanId", () => {
  it("generates 32-hex trace-ids", () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates 16-hex span-ids", () => {
    const id = generateSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("generates distinct trace-ids on every call", () => {
    const ids = new Set(Array.from({ length: 32 }, () => generateTraceId()));
    expect(ids.size).toBe(32);
  });

  it("generates distinct span-ids on every call", () => {
    const ids = new Set(Array.from({ length: 32 }, () => generateSpanId()));
    expect(ids.size).toBe(32);
  });

  it("never emits the all-zero forbidden values (CSPRNG sanity)", () => {
    for (let i = 0; i < 16; i += 1) {
      expect(generateTraceId()).not.toBe("0".repeat(32));
      expect(generateSpanId()).not.toBe("0".repeat(16));
    }
  });
});

describe("nextTraceContext", () => {
  it("inherits trace-id + flags from parent and refreshes span-id", () => {
    const parent = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      flags: "01",
    } as const;
    const child = nextTraceContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.flags).toBe(parent.flags);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("roots a new trace when no parent is provided", () => {
    const root = nextTraceContext();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.flags).toBe("01");
  });

  it("treats null/undefined parent as root", () => {
    expect(nextTraceContext(null).flags).toBe("01");
    expect(nextTraceContext(undefined).flags).toBe("01");
  });

  it("two children of the same parent share trace-id but not span-id", () => {
    const parent = nextTraceContext();
    const a = nextTraceContext(parent);
    const b = nextTraceContext(parent);
    expect(a.traceId).toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
  });
});
