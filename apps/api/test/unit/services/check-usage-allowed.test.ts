// SPDX-License-Identifier: Apache-2.0

/**
 * `checkUsageAllowed` — the chat-surface entry into the unified `beforeUsage`
 * admission hook (`services/chat-subscription.ts`). The chat module calls it for
 * its non-subscription (built-in / API-key) branch before starting a turn. The
 * gate resolves system-provided vs. org-owned SERVER-SIDE so the chat module
 * stays dumb, but that resolution is REPORTED, not used to pre-filter:
 *
 *   - every turn dispatches the hook, carrying `credentialSource`
 *     (`"system"` | `"org"`) and `executionPlane: "platform"` (a chat turn
 *     always runs in the platform's own process);
 *   - an org-credential turn is dispatched too — the platform no longer
 *     declares it free, the module quotes it (typically at zero) and decides;
 *   - no metering module → null (OSS allows all);
 *   - a metering module's rejection flows straight back (a 402 the route turns
 *     into problem+json).
 *
 * These are the exact facts a metering module (cloud) quotes against, so a
 * regression that stopped reporting one — or resurrected the old "skip the hook
 * for an org model" short-circuit — surfaces here rather than as a billing
 * incident.
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

  it("dispatches the hook for an org-owned model with credentialSource 'org'", async () => {
    // Sanity: the org preset is genuinely not a system model.
    expect(getSystemModels().has("org-preset-123")).toBe(false);

    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const result = await checkUsageAllowed({
      orgId: "org_1",
      presetId: "org-preset-123",
      sessionId: "chs_1",
    });

    // The platform no longer short-circuits an org-credential turn: it reports
    // the fact and lets the module quote it. (A metering module that only
    // meters platform-supplied inference quotes zero and returns null here —
    // same outcome as the old early return, decided by the module.)
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      orgId: "org_1",
      context: "chat",
      sessionId: "chs_1",
      credentialSource: "org",
      executionPlane: "platform",
    });
  });

  it("lets a metering module reject an org-owned model turn (platform compute is still platform-funded)", async () => {
    // The reversal that matters: a rejecting module CAN now block a BYOK chat
    // turn, because a chat turn always occupies platform compute. Whether it
    // does is the module's policy — the platform no longer forces "allowed".
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

    expect(result).toEqual({ code: "over_cap", message: "blocked", status: 402 });
    expect(calls).toHaveLength(1);
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
    // Dispatched with the chat discriminant + the session id (not the run
    // shape), plus the two execution facts the module quotes against.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      orgId: "org_1",
      context: "chat",
      sessionId: "chs_42",
      credentialSource: "system",
      executionPlane: "platform",
    });
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
