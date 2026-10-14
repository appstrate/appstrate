// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { unwrapMcpResult } from "../src/mcp-result.ts";

describe("unwrapMcpResult — envelope peeling", () => {
  const payload = { status: 200, body: { ok: true } };

  it("returns a plain object unchanged", () => {
    expect(unwrapMcpResult(payload)).toEqual(payload);
  });

  it("parses a JSON string", () => {
    expect(unwrapMcpResult(JSON.stringify(payload))).toEqual(payload);
  });

  it("peels a raw MCP content array of text parts", () => {
    const mcp = { content: [{ type: "text", text: JSON.stringify(payload) }] };
    expect(unwrapMcpResult(mcp)).toEqual(payload);
  });

  it("peels a bare content array", () => {
    expect(unwrapMcpResult([{ type: "text", text: JSON.stringify(payload) }])).toEqual(payload);
  });

  it("leaves a non-JSON string as-is", () => {
    expect(unwrapMcpResult("plain text")).toBe("plain text");
  });
});

describe("unwrapMcpResult — payload among several text parts", () => {
  // The Pi engine appends this model-facing line to every tool result.
  const budgetNote =
    "[turn budget] 7m44s left in this turn, step 1/16. " +
    "A run_and_wait launch needs at least 2m left or it is refused; " +
    "anything not written into your reply before the turn ends is lost.";
  const runPayload = {
    id: "run_da46b621",
    packageId: "@appstrate/inbox-triage",
    status: "success",
    done: true,
  };

  it("recovers the payload when a turn-budget note follows it", () => {
    const mcp = {
      content: [
        { type: "text", text: JSON.stringify(runPayload) },
        { type: "text", text: budgetNote },
      ],
    };
    expect(unwrapMcpResult(mcp)).toEqual(runPayload);
  });

  it("recovers the payload when a prose part precedes it", () => {
    // `mcpResultToPi` renders non-text MCP blocks as text (`[image …]`), so the
    // payload is not always the first text part.
    const parts = [
      { type: "text", text: "[image image/png]" },
      { type: "text", text: JSON.stringify(runPayload) },
    ];
    expect(unwrapMcpResult(parts)).toEqual(runPayload);
  });

  it("returns the joined text when no part carries a payload", () => {
    const parts = [
      { type: "text", text: "all done. " },
      { type: "text", text: budgetNote },
    ];
    expect(unwrapMcpResult(parts)).toBe(`all done. ${budgetNote}`);
  });

  it("leaves a content array with no text parts unchanged", () => {
    const parts = [
      { type: "image", data: "…" },
      { type: "image", data: "…" },
    ];
    expect(unwrapMcpResult(parts)).toEqual(parts);
  });
});
