// SPDX-License-Identifier: Apache-2.0

/**
 * `piToolResultOrThrow`, the adapter half of the tool-error contract: Pi
 * ignores an `isError` returned from `execute`, so a failed result is thrown.
 * The contract against the real Pi loop, through the production forwarder of
 * the sidecar's tools, lives beside that forwarder
 * (`runtime-pi/test/mcp-tool-error-contract.test.ts`).
 */

import { describe, it, expect } from "bun:test";
import { piToolResultOrThrow } from "../src/pi-tool-result.ts";

describe("piToolResultOrThrow", () => {
  it("returns content and details on success", () => {
    expect(
      piToolResultOrThrow({ content: [{ type: "text", text: "ok" }], details: { n: 1 } }),
    ).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: { n: 1 },
    });
  });

  it("throws the joined text blocks on failure", () => {
    expect(() =>
      piToolResultOrThrow({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
        isError: true,
      }),
    ).toThrow("first\nsecond");
  });

  it("still throws when a failure carries no text", () => {
    expect(() => piToolResultOrThrow({ content: [], isError: true })).toThrow("Tool call failed");
  });
});
