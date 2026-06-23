// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the provider-id-keyed subscription gateway registry that lets
 * the llm-proxy router mount its SDK gateways data-driven (A1) — no hardcoded
 * engine→handler map. The claude-code gateway self-registers on import.
 */

import { describe, it, expect } from "bun:test";
import type { Context } from "hono";
import {
  registerSubscriptionGateway,
  subscriptionGatewayFor,
  type SubscriptionGatewayHandler,
} from "../../../src/services/llm-proxy/subscription-gateways.ts";
import type { AppEnv } from "../../../src/types/index.ts";

describe("subscription gateway registry", () => {
  it("registers the claude-code gateway as a side effect of importing the gateway module", async () => {
    await import("../../../src/services/llm-proxy/claude-code-sdk-gateway.ts");
    expect(subscriptionGatewayFor("claude-code")).toBeDefined();
  });

  it("returns undefined for a provider with no registered gateway", () => {
    expect(subscriptionGatewayFor("not-a-provider")).toBeUndefined();
  });

  it("looks up a registered handler by provider id", () => {
    const handler: SubscriptionGatewayHandler = async () => new Response("ok");
    registerSubscriptionGateway("test-vendor", handler);
    expect(subscriptionGatewayFor("test-vendor")).toBe(handler);
  });

  it("is idempotent for an identical re-registration but throws on a conflict", () => {
    const a: SubscriptionGatewayHandler = async (_c: Context<AppEnv>) => new Response("a");
    const b: SubscriptionGatewayHandler = async (_c: Context<AppEnv>) => new Response("b");
    registerSubscriptionGateway("dup-vendor", a);
    expect(() => registerSubscriptionGateway("dup-vendor", a)).not.toThrow();
    expect(() => registerSubscriptionGateway("dup-vendor", b)).toThrow();
  });
});
