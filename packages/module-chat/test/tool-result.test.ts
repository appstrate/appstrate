// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { deriveToolPhase, extractErrorMessage, httpStatusOf } from "../src/ui/tool-result.ts";

describe("unwrapMcpResult through deriveToolPhase", () => {
  const budgetNote = "[turn budget] 7m44s left in this turn, step 1/16.";
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
