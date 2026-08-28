// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  unwrapResult,
  deriveToolPhase,
  extractErrorMessage,
  httpStatusOf,
} from "../src/ui/tool-result.ts";

describe("unwrapResult — envelope peeling", () => {
  const payload = { status: 200, body: { ok: true } };

  it("returns a plain object unchanged", () => {
    expect(unwrapResult(payload)).toEqual(payload);
  });

  it("parses a JSON string", () => {
    expect(unwrapResult(JSON.stringify(payload))).toEqual(payload);
  });

  it("peels a raw MCP content array of text parts", () => {
    const mcp = { content: [{ type: "text", text: JSON.stringify(payload) }] };
    expect(unwrapResult(mcp)).toEqual(payload);
  });

  it("peels a bare content array", () => {
    expect(unwrapResult([{ type: "text", text: JSON.stringify(payload) }])).toEqual(payload);
  });

  it("leaves a non-JSON string as-is", () => {
    expect(unwrapResult("plain text")).toBe("plain text");
  });
});

describe("unwrapResult — payload among several text parts", () => {
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
    expect(unwrapResult(mcp)).toEqual(runPayload);
  });

  it("recovers the payload when a prose part precedes it", () => {
    // `mcpResultToPi` renders non-text MCP blocks as text (`[image …]`), so the
    // payload is not always the first text part.
    const parts = [
      { type: "text", text: "[image image/png]" },
      { type: "text", text: JSON.stringify(runPayload) },
    ];
    expect(unwrapResult(parts)).toEqual(runPayload);
  });

  it("returns the joined text when no part carries a payload", () => {
    const parts = [
      { type: "text", text: "all done. " },
      { type: "text", text: budgetNote },
    ];
    expect(unwrapResult(parts)).toBe(`all done. ${budgetNote}`);
  });

  it("leaves a content array with no text parts unchanged", () => {
    const parts = [
      { type: "image", data: "…" },
      { type: "image", data: "…" },
    ];
    expect(unwrapResult(parts)).toEqual(parts);
  });

  it("a failing payload followed by the note still reads as an error", () => {
    const enveloped = {
      content: [
        { type: "text", text: JSON.stringify({ status: 502, error: "upstream unavailable" }) },
        { type: "text", text: budgetNote },
      ],
    };
    expect(deriveToolPhase({ status: { type: "complete" }, result: enveloped })).toBe("error");
  });
});

describe("deriveToolPhase", () => {
  it("running status → running", () => {
    expect(deriveToolPhase({ status: { type: "running" }, result: undefined })).toBe("running");
  });

  it("complete + 2xx result → success", () => {
    expect(
      deriveToolPhase({ status: { type: "complete" }, result: { status: 200, body: {} } }),
    ).toBe("success");
  });

  it("HTTP >= 400 in result → error", () => {
    expect(
      deriveToolPhase({ status: { type: "complete" }, result: { status: 404, error: "nope" } }),
    ).toBe("error");
  });

  it("part.isError flag → error", () => {
    expect(deriveToolPhase({ status: { type: "complete" }, isError: true, result: {} })).toBe(
      "error",
    );
  });

  it("outcome:denied → error", () => {
    expect(
      deriveToolPhase({ status: { type: "complete" }, result: { outcome: "denied", error: "x" } }),
    ).toBe("error");
  });

  it("incomplete status → error", () => {
    expect(
      deriveToolPhase({ status: { type: "incomplete", reason: "error" }, result: undefined }),
    ).toBe("error");
  });

  it("requires-action → pending", () => {
    expect(deriveToolPhase({ status: { type: "requires-action", reason: "interrupt" } })).toBe(
      "pending",
    );
  });

  it("reads through an MCP envelope before judging", () => {
    const enveloped = { content: [{ type: "text", text: JSON.stringify({ status: 500 }) }] };
    expect(deriveToolPhase({ status: { type: "complete" }, result: enveloped })).toBe("error");
  });
});

describe("extractErrorMessage", () => {
  it("prefers an explicit error string", () => {
    expect(extractErrorMessage({ error: "boom" })).toBe("boom");
  });

  it("falls back to McpError message", () => {
    expect(extractErrorMessage({ code: -32602, message: "bad params" })).toBe("bad params");
  });

  it("digs problem+json detail out of an HTTP error body", () => {
    expect(
      extractErrorMessage({
        status: 400,
        body: { title: "Bad Request", detail: "name is required" },
      }),
    ).toBe("name is required");
  });

  it("uses body.message when no detail/title", () => {
    expect(extractErrorMessage({ status: 422, body: { message: "validation failed" } })).toBe(
      "validation failed",
    );
  });

  it("uses a string error body verbatim", () => {
    expect(extractErrorMessage({ status: 500, body: "boom" })).toBe("boom");
  });

  it("synthesizes from HTTP status when the body carries no message", () => {
    expect(extractErrorMessage({ status: 503 })).toBe("HTTP 503");
    expect(extractErrorMessage({ status: 403, body: {} })).toBe("HTTP 403");
  });
});

describe("httpStatusOf", () => {
  it("reads a numeric status", () => {
    expect(httpStatusOf({ status: 201, body: {} })).toBe(201);
  });

  it("returns undefined when absent", () => {
    expect(httpStatusOf({ body: {} })).toBeUndefined();
  });
});
