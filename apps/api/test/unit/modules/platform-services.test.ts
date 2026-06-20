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

  it("wires the run-ledger read (runs.listLlmUsage — consumer: cloud)", () => {
    expect(typeof services.runs.listLlmUsage).toBe("function");
  });

  it("wires the credential proxy (credentialProxy.call — consumer: storage)", () => {
    expect(typeof services.credentialProxy.call).toBe("function");
  });

  it("wires the event emitter (events.emit — consumer: storage→search seam)", () => {
    expect(typeof services.events.emit).toBe("function");
  });

  it("wires job queues (queues.create + processingEnabled — consumer: search ingestion)", () => {
    expect(typeof services.queues.create).toBe("function");
    expect(typeof services.queues.processingEnabled).toBe("boolean");
  });
});
