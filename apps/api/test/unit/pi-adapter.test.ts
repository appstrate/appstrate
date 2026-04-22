// SPDX-License-Identifier: Apache-2.0

/**
 * parsePiStreamLine / processPiLogs moved to @appstrate/runner-pi (see
 * packages/runner-pi/test/stream-parser.test.ts). Only the platform-
 * specific deriveKeyPlaceholder helper remains here.
 */

import { describe, it, expect } from "bun:test";
import { _deriveKeyPlaceholderForTesting as deriveKeyPlaceholder } from "../../src/services/adapters/pi.ts";

describe("deriveKeyPlaceholder", () => {
  it("returns sk-placeholder for undefined key", () => {
    expect(deriveKeyPlaceholder(undefined)).toBe("sk-placeholder");
  });

  it("returns sk-placeholder for empty string", () => {
    expect(deriveKeyPlaceholder("")).toBe("sk-placeholder");
  });

  it("returns sk-placeholder for key without dashes", () => {
    expect(deriveKeyPlaceholder("simpletokenkey")).toBe("sk-placeholder");
  });

  it("preserves prefix for Anthropic-style keys", () => {
    expect(deriveKeyPlaceholder("sk-ant-api03-secret123")).toBe("sk-ant-api03-placeholder");
  });

  it("preserves prefix for OpenAI-style keys", () => {
    expect(deriveKeyPlaceholder("sk-proj-abc123")).toBe("sk-proj-placeholder");
  });

  it("preserves single-segment prefix", () => {
    expect(deriveKeyPlaceholder("sk-mysecretkey")).toBe("sk-placeholder");
  });

  it("handles multi-segment prefix", () => {
    expect(deriveKeyPlaceholder("a-b-c-d-secret")).toBe("a-b-c-d-placeholder");
  });
});
