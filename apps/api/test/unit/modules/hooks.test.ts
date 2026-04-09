// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import {
  checkQuota,
  recordUsage,
  onOrgCreated,
  onOrgDeleted,
  getQuotaExceededError,
} from "../../../src/lib/modules/hooks.ts";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";

function mockCtx(): ModuleInitContext {
  return {
    databaseUrl: null,
    redisUrl: null,
    appUrl: "http://localhost:3000",
    isEmbeddedDb: true,
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    registerEmailOverrides: () => {},
    setBeforeSignupHook: () => {},
  };
}

describe("module hooks (agnostic)", () => {
  beforeEach(() => {
    resetModules();
  });

  it("checkQuota is no-op when no module provides the hook", async () => {
    await loadModulesFromInstances([], mockCtx());
    await expect(checkQuota("org1", 5)).resolves.toBeUndefined();
  });

  it("recordUsage returns undefined when no module provides the hook", async () => {
    await loadModulesFromInstances([], mockCtx());
    const result = await recordUsage("org1", "run1", 0.5, { modelSource: "system" });
    expect(result).toBeUndefined();
  });

  it("onOrgCreated is no-op when no module provides the event", async () => {
    await loadModulesFromInstances([], mockCtx());
    await expect(onOrgCreated("org1", "user@test.com")).resolves.toBeUndefined();
  });

  it("onOrgDeleted is no-op when no module provides the event", async () => {
    await loadModulesFromInstances([], mockCtx());
    await expect(onOrgDeleted("org1")).resolves.toBeUndefined();
  });

  it("getQuotaExceededError returns null when no module provides the hook", async () => {
    await loadModulesFromInstances([], mockCtx());
    expect(getQuotaExceededError()).toBeNull();
  });

  it("delegates to module hooks when provided", async () => {
    const mockCheckQuota = mock(async () => {});
    const mockRecordUsage = mock(async () => ({ credits: 10 }));
    const mockOnOrgCreated = mock(async () => {});
    const mockOnOrgDeleted = mock(async () => {});

    class FakeQuotaError extends Error {
      code = "QUOTA_EXCEEDED" as const;
    }

    const mod: AppstrateModule = {
      manifest: { id: "billing", name: "Billing", version: "1.0.0" },
      async init() {},
      hooks: {
        checkQuota: mockCheckQuota,
        recordUsage: mockRecordUsage,
        getQuotaExceededError: () => FakeQuotaError,
      },
      events: {
        onOrgCreated: mockOnOrgCreated,
        onOrgDeleted: mockOnOrgDeleted,
      },
    };

    await loadModulesFromInstances([mod], mockCtx());

    await checkQuota("org1", 3);
    expect(mockCheckQuota).toHaveBeenCalledWith("org1", 3);

    const result = await recordUsage("org1", "run1", 1.5, { modelSource: "openai" });
    expect(result).toEqual({ credits: 10 });

    await onOrgCreated("org1", "admin@test.com");
    expect(mockOnOrgCreated).toHaveBeenCalledWith("org1", "admin@test.com");

    await onOrgDeleted("org2");
    expect(mockOnOrgDeleted).toHaveBeenCalledWith("org2");

    const QEE = getQuotaExceededError();
    expect(QEE).toBe(FakeQuotaError);
  });

  it("onOrgCreated broadcasts to ALL modules (event semantics)", async () => {
    const handlerA = mock(async () => {});
    const handlerB = mock(async () => {});

    const modA: AppstrateModule = {
      manifest: { id: "billing", name: "Billing", version: "1.0.0" },
      async init() {},
      events: { onOrgCreated: handlerA },
    };
    const modB: AppstrateModule = {
      manifest: { id: "analytics", name: "Analytics", version: "1.0.0" },
      async init() {},
      events: { onOrgCreated: handlerB },
    };

    await loadModulesFromInstances([modA, modB], mockCtx());

    await onOrgCreated("org1", "admin@test.com");
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });
});
