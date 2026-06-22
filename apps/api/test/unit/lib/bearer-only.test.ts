// SPDX-License-Identifier: Apache-2.0

/**
 * Bearer-only + loopback-only auth gates.
 *
 * `assertBearerOnly` accepts the four bearer strategies and rejects cookie
 * sessions / unknown ids. `assertLoopbackOnly` (subscription LLM gateways)
 * narrows further to ONLY the chat loopback bearer — a dashboard token must
 * not be usable to drive a personal subscription as a bare proxy.
 */

import { describe, expect, it } from "bun:test";
import { assertBearerOnly, assertLoopbackOnly } from "../../../src/lib/bearer-only.ts";

describe("assertBearerOnly", () => {
  for (const method of ["api_key", "oauth2-instance", "oauth2-dashboard", "chat-loopback"]) {
    it(`accepts ${method}`, () => {
      expect(() => assertBearerOnly(method, "LLM proxy")).not.toThrow();
    });
  }

  for (const method of ["session", "unknown-strategy", undefined]) {
    it(`rejects ${String(method)}`, () => {
      expect(() => assertBearerOnly(method, "LLM proxy")).toThrow();
    });
  }
});

describe("assertLoopbackOnly", () => {
  it("accepts the chat loopback bearer", () => {
    expect(() => assertLoopbackOnly("chat-loopback", "Claude Code SDK gateway")).not.toThrow();
  });

  // The whole point of B2: even a valid first-party dashboard token is refused,
  // so the subscription can't be driven as a non-official-client proxy.
  for (const method of ["oauth2-dashboard", "oauth2-instance", "api_key", "session", undefined]) {
    it(`rejects ${String(method)}`, () => {
      expect(() => assertLoopbackOnly(method, "Claude Code SDK gateway")).toThrow();
    });
  }
});
