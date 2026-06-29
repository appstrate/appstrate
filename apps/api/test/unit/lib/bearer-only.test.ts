// SPDX-License-Identifier: Apache-2.0

/**
 * Bearer-only + loopback-only auth gates.
 *
 * `assertBearerOnly` accepts the three bearer strategies (or any caller that
 * declared the first-party loopback capability) and rejects cookie sessions /
 * unknown ids. `assertLoopbackOnly` (subscription LLM gateways) narrows further
 * to ONLY a first-party loopback caller — a dashboard token must not be usable
 * to drive a personal subscription as a bare proxy. Core gates on the DECLARED
 * capability, not on any specific module's auth-method id.
 */

import { describe, expect, it } from "bun:test";
import { assertBearerOnly, assertLoopbackOnly } from "../../../src/lib/bearer-only.ts";

const LOOPBACK = { firstPartyLoopback: true };

describe("assertBearerOnly", () => {
  for (const method of ["api_key", "oauth2-instance", "oauth2-dashboard"]) {
    it(`accepts ${method}`, () => {
      expect(() => assertBearerOnly(method, "LLM proxy")).not.toThrow();
    });
  }

  it("accepts any caller declaring the first-party loopback capability", () => {
    // No accepted authMethod string, but the declared capability claims it.
    expect(() => assertBearerOnly("chat-loopback", "LLM proxy", LOOPBACK)).not.toThrow();
    expect(() => assertBearerOnly(undefined, "LLM proxy", LOOPBACK)).not.toThrow();
  });

  for (const method of ["session", "unknown-strategy", undefined]) {
    it(`rejects ${String(method)} without the loopback capability`, () => {
      expect(() => assertBearerOnly(method, "LLM proxy")).toThrow();
    });
  }
});

describe("assertLoopbackOnly", () => {
  it("accepts a first-party loopback caller (capability declared)", () => {
    expect(() =>
      assertLoopbackOnly("chat-loopback", "Claude Code SDK gateway", LOOPBACK),
    ).not.toThrow();
  });

  // Even a valid first-party dashboard token is refused without the loopback
  // capability, so the subscription can't be driven as a non-official-client proxy.
  for (const method of ["oauth2-dashboard", "oauth2-instance", "api_key", "session", undefined]) {
    it(`rejects ${String(method)} (no loopback capability)`, () => {
      expect(() => assertLoopbackOnly(method, "Claude Code SDK gateway")).toThrow();
    });
  }
});
