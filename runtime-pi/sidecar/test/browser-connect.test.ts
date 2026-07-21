// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { browserSafeErrorCode, parseBrowserAcquisitionResult } from "../browser-connect.ts";

function toolResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

describe("browser connect private result parser", () => {
  it("accepts only allowlisted outputs with a successful proof", () => {
    expect(
      parseBrowserAcquisitionResult(
        toolResult({
          outputs: { cookie: "sid=x" },
          proof: { kind: "authenticated-page", succeeded: true },
          scopes_granted: ["read"],
          expires_at: "2026-07-20T00:00:00.000Z",
        }),
        ["cookie"],
        "exportable",
      ),
    ).toEqual({
      outputs: { cookie: "sid=x" },
      proof: { kind: "authenticated-page", succeeded: true },
      scopesGranted: ["read"],
      expiresAt: "2026-07-20T00:00:00.000Z",
    });
  });

  it("rejects failed proofs, malformed outputs, and undeclared values", () => {
    expect(() =>
      parseBrowserAcquisitionResult(
        toolResult({ outputs: { cookie: "x" }, proof: { kind: "check", succeeded: false } }),
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/proof did not succeed/);
    expect(() =>
      parseBrowserAcquisitionResult(
        toolResult({
          outputs: { token: "secret" },
          proof: { kind: "check", succeeded: true },
        }),
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/undeclared output/);
    expect(() =>
      parseBrowserAcquisitionResult(
        toolResult({
          outputs: { cookie: "x" },
          proof: { kind: "check", succeeded: true },
          debug_dump: "must not cross the trusted boundary",
        }),
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/unknown field 'debug_dump'/);
    expect(() =>
      parseBrowserAcquisitionResult(
        toolResult({
          outputs: { cookie: "x" },
          proof: { kind: "check", succeeded: true },
          expires_at: "not-a-date",
        }),
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/valid timestamp/);
    expect(() =>
      parseBrowserAcquisitionResult(
        toolResult({
          outputs: { cookie: "x" },
          proof: { kind: "check", succeeded: true },
          expires_at: 123,
        }),
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/valid timestamp/);
    expect(() =>
      parseBrowserAcquisitionResult(
        toolResult({
          outputs: { cookie: "x" },
          proof: { kind: "check", succeeded: true, debug: "secret" },
        }),
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/proof did not succeed/);
  });

  it("bounds results before parsing and strips arbitrary driver errors to canonical codes", () => {
    expect(() =>
      parseBrowserAcquisitionResult(
        { content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }] },
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/size limit/);
    expect(browserSafeErrorCode(new Error("BROWSER_CRASHED: password=hunter2"))).toBe(
      "BROWSER_CRASHED",
    );
    expect(browserSafeErrorCode(new Error("BROWSER_RESOURCE_LIMIT: host slots occupied"))).toBe(
      "BROWSER_RESOURCE_LIMIT",
    );
    expect(browserSafeErrorCode(new Error("BROWSER_BUNDLE_UNAVAILABLE: HTTP 401"))).toBe(
      "BROWSER_BUNDLE_UNAVAILABLE",
    );
    expect(browserSafeErrorCode(new Error("BROWSER_STATE_READ_FAILED: private detail"))).toBe(
      "BROWSER_STATE_READ_FAILED",
    );
    expect(browserSafeErrorCode(new Error("BROWSER_DRIVER_ATTACH_FAILED: private detail"))).toBe(
      "BROWSER_DRIVER_ATTACH_FAILED",
    );
    expect(browserSafeErrorCode(new Error("BROWSER_PAGE_TRANSITION_FAILED: private detail"))).toBe(
      "BROWSER_PAGE_TRANSITION_FAILED",
    );
    expect(browserSafeErrorCode(new Error("driver failed with password=hunter2"))).toBe(
      "BROWSER_UNAVAILABLE",
    );
    expect(() =>
      parseBrowserAcquisitionResult(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: "BROWSER_INTERACTION_REQUIRED: challenge details must stay private",
            },
          ],
        },
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/^BROWSER_INTERACTION_REQUIRED$/);
    expect(() =>
      parseBrowserAcquisitionResult(
        {
          isError: true,
          content: [{ type: "text", text: "driver failed with password=hunter2" }],
        },
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/^BROWSER_UNAVAILABLE$/);
  });
});
