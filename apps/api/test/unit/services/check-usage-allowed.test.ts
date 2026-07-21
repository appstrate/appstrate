// SPDX-License-Identifier: Apache-2.0

/**
 * `checkUsageAllowed` — the chat-surface entry into the unified `beforeUsage`
 * admission hook (`services/chat-subscription.ts`). The chat module calls it for
 * its non-subscription (built-in / API-key) branch before starting a turn. The
 * gate decides system-provided vs. org-owned SERVER-SIDE so the module stays
 * dumb:
 *
 *   - an org's own model is never platform-metered → null WITHOUT dispatching
 *     the hook (an org spends its own credential, no gate to run);
 *   - a system-provided model with no metering module → null (OSS allows all);
 *   - a system-provided model with a metering module → the module's rejection
 *     flows straight back (a 402 the route turns into problem+json).
 *
 * These are the exact branches a metering module (cloud) depends on, so a
 * regression that gated an org's own model — or failed to gate a system one —
 * would surface here rather than as a billing incident.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { checkUsageAllowed } from "../../../src/services/chat-subscription.ts";
import {
  initSystemModelProviderKeys,
  getSystemModels,
} from "../../../src/services/model-registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import type {
  AppstrateModule,
  ModuleInitContext,
  BeforeUsageParams,
  UsageRejection,
} from "@appstrate/core/module";

const SYSTEM_PRESET = "sys-chat-model";

function fakeInitCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    services: {} as ModuleInitContext["services"],
  };
}

/** A module whose `beforeUsage` records its args and returns a scripted result. */
function gateModule(result: UsageRejection | null, calls: BeforeUsageParams[]): AppstrateModule {
  return {
    manifest: { id: "test-gate", name: "Gate", version: "0.0.0" },
    async init() {},
    hooks: {
      beforeUsage: async (params) => {
        calls.push(params);
        return result;
      },
    },
  };
}

describe("checkUsageAllowed", () => {
  beforeEach(() => {
    resetModules();
    // Register a real system-provided model so `isSystemModel` distinguishes it
    // from an org's own preset (the whole gating decision hinges on this).
    seedTestModelProviders();
    initSystemModelProviderKeys([
      {
        id: "sys-key",
        providerId: "test-apikey",
        apiKey: "sk-system",
        models: [{ id: SYSTEM_PRESET, modelId: "gpt-4o-2024-08-06" }],
      },
    ]);
  });

  afterAll(() => {
    resetModules();
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("returns null for an org-owned model WITHOUT dispatching the hook", async () => {
    // Sanity: the org preset is genuinely not a system model.
    expect(getSystemModels().has("org-preset-123")).toBe(false);

    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "over_cap", message: "blocked", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const result = await checkUsageAllowed({
      orgId: "org_1",
      presetId: "org-preset-123",
      sessionId: "chs_1",
    });

    // Org's own credential is never platform-metered — short-circuits BEFORE the
    // hook (so even a rejecting metering module can't block it).
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null for a system model when no metering module provides the hook", async () => {
    // No module loaded → OSS mode allows everything.
    const result = await checkUsageAllowed({
      orgId: "org_1",
      presetId: SYSTEM_PRESET,
      sessionId: "chs_1",
    });
    expect(result).toBeNull();
  });

  it("passes a metering module's rejection through for a system model (chat context)", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "over_cap", message: "Soft cap reached", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const result = await checkUsageAllowed({
      orgId: "org_1",
      presetId: SYSTEM_PRESET,
      sessionId: "chs_42",
    });

    expect(result).toEqual({ code: "over_cap", message: "Soft cap reached", status: 402 });
    // Dispatched with the chat discriminant + the session id (not the run shape).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ orgId: "org_1", context: "chat", sessionId: "chs_42" });
  });

  it("returns null for a system model when the metering module allows the turn", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const result = await checkUsageAllowed({
      orgId: "org_1",
      presetId: SYSTEM_PRESET,
      sessionId: null,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    // An ephemeral (unpersisted) turn dispatches a null session id.
    expect(calls[0]!.context).toBe("chat");
    expect((calls[0] as { sessionId: string | null }).sessionId).toBeNull();
  });
});
