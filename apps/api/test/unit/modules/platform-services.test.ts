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

  it("wires the orchestrator accessor", () => {
    expect(typeof services.orchestrator.get).toBe("function");
  });

  it("wires the pubsub accessor", () => {
    expect(typeof services.pubsub.get).toBe("function");
  });

  it("wires env tier detection", () => {
    expect(typeof services.env.hasRedis).toBe("function");
    expect(typeof services.env.hasExternalDb).toBe("function");
    expect(typeof services.env.hasRedis()).toBe("boolean");
    expect(typeof services.env.hasExternalDb()).toBe("boolean");
  });

  it("wires the model catalog", () => {
    expect(typeof services.models.load).toBe("function");
    expect(typeof services.models.listForOrg).toBe("function");
  });

  it("wires the package catalog", () => {
    expect(typeof services.packages.get).toBe("function");
    expect(typeof services.packages.isInlineShadow).toBe("function");
    expect(services.packages.isInlineShadow("@inline/foo")).toBe(true);
    expect(services.packages.isInlineShadow("@scope/foo")).toBe(false);
  });

  it("wires applications helpers", () => {
    expect(typeof services.applications.getDefault).toBe("function");
  });

  it("wires connections helpers", () => {
    expect(typeof services.connections.listAllForActor).toBe("function");
  });

  it("wires run lifecycle operations", () => {
    expect(typeof services.runs.appendLog).toBe("function");
    expect(typeof services.runs.update).toBe("function");
    expect(typeof services.runs.abort).toBe("function");
  });

  it("wires the inline preflight (validation-only, no side effects)", () => {
    expect(typeof services.inline.preflight).toBe("function");
  });

  it("wires the realtime subscriber registry", () => {
    expect(typeof services.realtime.addSubscriber).toBe("function");
    expect(typeof services.realtime.removeSubscriber).toBe("function");
  });

  it("wires the module registry accessors", () => {
    expect(typeof services.modules.get).toBe("function");
    expect(typeof services.modules.emit).toBe("function");
  });
});
