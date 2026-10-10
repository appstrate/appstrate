// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { MAX_WAIT_SECONDS, WAIT_RESPONSE_MARGIN_SECONDS } from "../../src/lib/run-wait-limits.ts";

describe("run-wait limits", () => {
  it("keeps MAX_WAIT_SECONDS at 55 (a change moves the OpenAPI text and AGENTS.md:536)", () => {
    expect(MAX_WAIT_SECONDS).toBe(55);
  });

  it("makes the wait plus the response margin fit one MCP client request", () => {
    expect(MAX_WAIT_SECONDS * 1000 + WAIT_RESPONSE_MARGIN_SECONDS * 1000).toBe(
      DEFAULT_REQUEST_TIMEOUT_MSEC,
    );
  });

  it("reserves at least 5 seconds for the response to cross the proxy", () => {
    expect(WAIT_RESPONSE_MARGIN_SECONDS).toBeGreaterThanOrEqual(5);
  });
});
