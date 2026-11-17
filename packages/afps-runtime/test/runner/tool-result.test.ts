// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { truncateToolResult } from "../../src/runner/tool-result.ts";

const bytes = 30_000;
const b64 = Buffer.alloc(bytes, 7).toString("base64");

describe("truncateToolResult", () => {
  it("summarises an image block and keeps the pointer text", () => {
    const pointer = "[image → saved to workspace file resources/x-image-0.png (30000 bytes)]";
    const result = {
      content: [
        { type: "text", text: "Photo:" },
        { type: "image", data: b64, mimeType: "image/png" },
        { type: "text", text: pointer },
      ],
    };
    const out = truncateToolResult(result) as { content: unknown[] };
    const json = JSON.stringify(out);
    expect(json).not.toContain(b64.slice(0, 64));
    expect(json).not.toContain("__truncated");
    expect(out.content[1]).toEqual({ type: "image", mimeType: "image/png", bytes });
    expect(out.content[2]).toEqual({ type: "text", text: pointer });
  });

  it("summarises a nested image and counts padding", () => {
    const data = Buffer.from("ab").toString("base64"); // "YWI=" -> 2 bytes
    const out = truncateToolResult({
      details: { shots: [{ type: "image", data, mimeType: "image/jpeg" }] },
    });
    expect(out).toEqual({
      details: { shots: [{ type: "image", mimeType: "image/jpeg", bytes: 2 }] },
    });
  });

  it("returns the same reference when there is no image", () => {
    const result = { content: [{ type: "text", text: "hi" }] };
    expect(truncateToolResult(result)).toBe(result);
  });

  it("still truncates a large text result", () => {
    const out = truncateToolResult({ text: "x".repeat(5000) }) as Record<string, unknown>;
    expect(out.__truncated).toBe(true);
    expect(out.reason).toBe("size");
  });
});
