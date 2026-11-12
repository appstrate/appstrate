// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { MAX_WAIT_SECONDS, parseWaitSeconds } from "../../src/lib/run-wait-limits.ts";

describe("run-wait limits", () => {
  it('keeps MAX_WAIT_SECONDS at 55 (a change moves the OpenAPI text and the AGENTS.md "Operational Notes & Known Limitations" section)', () => {
    expect(MAX_WAIT_SECONDS).toBe(55);
  });

  it("answers an MCP client's getRun?wait=true before the SDK request timeout", () => {
    expect(MAX_WAIT_SECONDS).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MSEC / 1000);
  });
});

describe("parseWaitSeconds", () => {
  it("maps true to the ceiling and false to no wait", () => {
    expect(parseWaitSeconds("true", 1800)).toBe(1800);
    expect(parseWaitSeconds("false", 1800)).toBe(0);
  });

  it("clamps integer seconds to the ceiling the caller passes", () => {
    expect(parseWaitSeconds("0", MAX_WAIT_SECONDS)).toBe(0);
    expect(parseWaitSeconds("120", MAX_WAIT_SECONDS)).toBe(MAX_WAIT_SECONDS);
    expect(parseWaitSeconds("120", 1800)).toBe(120);
    expect(parseWaitSeconds("9999", 1800)).toBe(1800);
  });

  it("returns null for a negative, fractional or non-numeric value", () => {
    for (const bad of ["-1", "1.5", "abc", "yes"]) {
      expect(parseWaitSeconds(bad, 1800)).toBeNull();
    }
  });
});
