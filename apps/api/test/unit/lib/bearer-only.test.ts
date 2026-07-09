// SPDX-License-Identifier: Apache-2.0

/**
 * Bearer-only auth gate.
 *
 * `assertBearerOnly` accepts the three bearer strategies (or any caller that
 * declared the first-party loopback capability) and rejects cookie sessions /
 * unknown ids. Core gates on the DECLARED capability, not on any specific
 * module's auth-method id.
 */

import { describe, expect, it } from "bun:test";
import { assertBearerOnly } from "../../../src/lib/bearer-only.ts";

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
