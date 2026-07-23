// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll } from "bun:test";
import type { ModuleInitContext } from "@appstrate/core/module";
import { buildModuleInitContext } from "../../../src/lib/modules/registry.ts";

/**
 * Shape contract for `ctx.services`. Catches silent regressions when a
 * service is renamed/removed in apps/api but the binding in
 * buildPlatformServices() is missed. The PlatformServices interface in core
 * is the source of truth — this test asserts every documented namespace is
 * wired and exposes the documented methods as functions.
 */
describe("ModuleInitContext.services — platform service wiring", () => {
  let ctx: ModuleInitContext;
  let services: ModuleInitContext["services"];

  beforeAll(() => {
    // Lazy construction: if `getEnv()` throws (strict Zod validation), the
    // failure surfaces inside a hook so each `it` still reports clearly —
    // rather than tearing down the entire file at load time.
    ctx = buildModuleInitContext();
    services = ctx.services;
  });

  it("wires the logger", () => {
    expect(services.logger).toBeDefined();
    expect(typeof services.logger.info).toBe("function");
  });

  it("wires the ledger cursor read (usage.list + usage.settledFrontier — sole cross-tenant consumer: cloud)", () => {
    expect(typeof services.usage.list).toBe("function");
    expect(typeof services.usage.settledFrontier).toBe("function");
  });

  it("wires the per-route rate limiter (http.rateLimit)", () => {
    expect(typeof services.http.rateLimit).toBe("function");
  });

  it("wires in-process dispatch (inProcess.dispatch — chat caller-context + model reads)", () => {
    expect(typeof services.inProcess.dispatch).toBe("function");
  });

  it("wires the subscription-chat channel (resolveSubscriptionChatModel + recordChatUsage + checkUsageAllowed)", () => {
    expect(typeof services.resolveSubscriptionChatModel).toBe("function");
    expect(typeof services.recordChatUsage).toBe("function");
    expect(typeof services.checkUsageAllowed).toBe("function");
  });

  it("wires the chat document seam (resolveChatAttachment + cleanupSessionDocuments)", () => {
    expect(typeof services.resolveChatAttachment).toBe("function");
    expect(typeof services.cleanupSessionDocuments).toBe("function");
  });

  it("wires the org query helpers (getOrgAdminEmails + getOrgName)", () => {
    expect(typeof ctx.getOrgAdminEmails).toBe("function");
    expect(typeof ctx.getOrgName).toBe("function");
  });
});
