// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  formatTurnBudgetNote,
  isTurnBudgetNoteBlock,
  omitTurnBudgetNote,
  turnBudgetNoteBlock,
} from "../src/chat-turn-metadata.ts";
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
  const budgetNote = formatTurnBudgetNote({ remainingMs: 464_000, stepsUsed: 1 });
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
        turnBudgetNoteBlock(budgetNote),
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

  it("returns the joined text when no part carries a payload, whatever its wording", () => {
    const parts = [
      { type: "text", text: "403 Resource not accessible. " },
      { type: "text", text: "[turn budget] Retry later." },
    ];
    expect(unwrapMcpResult(parts)).toBe("403 Resource not accessible. [turn budget] Retry later.");
  });

  it("recognises the note by its marker, never by its text", () => {
    const note = turnBudgetNoteBlock(budgetNote);
    expect(isTurnBudgetNoteBlock(note)).toBe(true);
    expect(isTurnBudgetNoteBlock({ type: "text", text: budgetNote })).toBe(false);
    const parts = [{ type: "text", text: "boom" }, { type: "text", text: budgetNote }, note];
    expect(omitTurnBudgetNote({ content: parts, details: 1 })).toEqual({
      content: parts.slice(0, 2),
      details: 1,
    });
    expect(omitTurnBudgetNote(parts)).toEqual(parts.slice(0, 2));
  });

  it("leaves a content array with no text parts unchanged", () => {
    const parts = [
      { type: "image", data: "…" },
      { type: "image", data: "…" },
    ];
    expect(unwrapMcpResult(parts)).toEqual(parts);
  });
});
