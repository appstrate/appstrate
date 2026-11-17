// SPDX-License-Identifier: Apache-2.0

/**
 * Bearer-only auth gate.
 *
 * Both surfaces accept the three allowlisted bearer strategies and reject cookie
 * sessions / unknown ids. Outside the list, each admits only its own DECLARED
 * capability, never a module's auth-method id: the credential proxy a
 * `serverMinted` bearer, the LLM proxy a `firstPartyLoopback` one.
 */

import { describe, expect, it } from "bun:test";
import {
  assertBearerOnly,
  isBearerOnlyCaller,
  type BearerOnlySurface,
} from "../../../src/lib/bearer-only.ts";

const SURFACES: BearerOnlySurface[] = ["credential-proxy", "llm-proxy"];
/** The chat's platform-MCP bearer: server-minted, not an inference loopback. */
const MCP_BEARER = { authMethod: "chat-loopback", serverMinted: true };
/** The chat's inference bearer: both capabilities. */
const INFERENCE_BEARER = {
  authMethod: "chat-loopback",
  serverMinted: true,
  firstPartyLoopback: true,
};

describe("assertBearerOnly", () => {
  for (const surface of SURFACES) {
    for (const authMethod of ["api_key", "oauth2-instance", "oauth2-dashboard"]) {
      it(`${surface} accepts ${authMethod}`, () => {
        expect(() => assertBearerOnly({ authMethod }, surface)).not.toThrow();
      });
    }

    for (const authMethod of ["session", "unknown-strategy", undefined]) {
      it(`${surface} rejects ${String(authMethod)} without a capability`, () => {
        expect(() => assertBearerOnly({ authMethod }, surface)).toThrow();
      });
    }

    it(`${surface} accepts the inference bearer`, () => {
      expect(isBearerOnlyCaller(INFERENCE_BEARER, surface)).toBe(true);
    });
  }

  it("the credential proxy accepts a server-minted bearer, whatever its auth method", () => {
    expect(isBearerOnlyCaller(MCP_BEARER, "credential-proxy")).toBe(true);
    expect(isBearerOnlyCaller({ serverMinted: true }, "credential-proxy")).toBe(true);
  });

  it("the LLM proxy refuses a server-minted bearer that is no inference loopback", () => {
    expect(() => assertBearerOnly(MCP_BEARER, "llm-proxy")).toThrow();
  });

  it("a capability declared false admits nothing", () => {
    expect(
      isBearerOnlyCaller({ authMethod: "session", serverMinted: false }, "credential-proxy"),
    ).toBe(false);
    expect(
      isBearerOnlyCaller({ authMethod: "session", firstPartyLoopback: false }, "llm-proxy"),
    ).toBe(false);
  });
});
