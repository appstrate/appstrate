// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import {
  beforeSignup,
  beforeRun,
  afterRun,
  onOrgCreated,
  onOrgDeleted,
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
  };
}

describe("module hooks (lifecycle)", () => {
  beforeEach(() => {
    resetModules();
  });

  // ---------------------------------------------------------------------------
  // beforeSignup — hook (first-match-wins, throws to reject)
  // ---------------------------------------------------------------------------

  it("beforeSignup is no-op when no module provides the hook (OSS)", async () => {
    await loadModulesFromInstances([], mockCtx());
    await expect(beforeSignup("user@example.com")).resolves.toBeUndefined();
  });

  it("beforeSignup throws when a module rejects the signup", async () => {
    const mod: AppstrateModule = {
      manifest: { id: "cloud", name: "Cloud", version: "1.0.0" },
      async init() {},
      hooks: {
        beforeSignup: async (email: string) => {
          if (!email.endsWith("@allowed.com")) {
            throw new Error("Domain not allowed");
          }
        },
      },
    };

    await loadModulesFromInstances([mod], mockCtx());

    // Allowed domain — no throw
    await expect(beforeSignup("user@allowed.com")).resolves.toBeUndefined();

    // Blocked domain — throws
    await expect(beforeSignup("user@blocked.com")).rejects.toThrow("Domain not allowed");
  });

  // ---------------------------------------------------------------------------
  // beforeRun — hook (first-match-wins)
  // ---------------------------------------------------------------------------

  it("beforeRun returns undefined when no module provides the hook (OSS)", async () => {
    await loadModulesFromInstances([], mockCtx());
    const result = await beforeRun({ orgId: "org1", agentId: "agent1", runningCount: 5 });
    expect(result).toBeUndefined();
  });

  it("beforeRun returns rejection when a module blocks the run", async () => {
    const mod: AppstrateModule = {
      manifest: { id: "billing", name: "Billing", version: "1.0.0" },
      async init() {},
      hooks: {
        beforeRun: async (params: { orgId: string; runningCount: number }) => {
          if (params.runningCount >= 3) {
            return { code: "quota_exceeded", message: "Free tier limit reached" };
          }
          return null;
        },
      },
    };

    await loadModulesFromInstances([mod], mockCtx());

    // Under quota — no rejection
    const allowed = await beforeRun({ orgId: "org1", agentId: "agent1", runningCount: 2 });
    expect(allowed).toBeNull();

    // Over quota — rejected
    const rejected = await beforeRun({ orgId: "org1", agentId: "agent1", runningCount: 5 });
    expect(rejected).toEqual({ code: "quota_exceeded", message: "Free tier limit reached" });
  });

  it("beforeRun uses first-match-wins semantics (only first provider called)", async () => {
    const hookA = mock(async () => ({ code: "rate_limit", message: "Too fast" }));
    const hookB = mock(async () => ({ code: "blocked", message: "should not be called" }));

    const modA: AppstrateModule = {
      manifest: { id: "gate-a", name: "Gate A", version: "1.0.0" },
      async init() {},
      hooks: { beforeRun: hookA },
    };
    const modB: AppstrateModule = {
      manifest: { id: "gate-b", name: "Gate B", version: "1.0.0" },
      async init() {},
      hooks: { beforeRun: hookB },
    };

    await loadModulesFromInstances([modA, modB], mockCtx());

    const result = await beforeRun({ orgId: "org1", agentId: "agent1", runningCount: 1 });
    expect(result).toEqual({ code: "rate_limit", message: "Too fast" });
    expect(hookA).toHaveBeenCalledTimes(1);
    // First-match-wins: only the first module's hook is called
    expect(hookB).toHaveBeenCalledTimes(0);
  });

  // ---------------------------------------------------------------------------
  // afterRun — event (broadcast-to-all)
  // ---------------------------------------------------------------------------

  it("afterRun is no-op when no module provides the event", async () => {
    await loadModulesFromInstances([], mockCtx());
    await expect(
      afterRun({
        orgId: "org1",
        runId: "run1",
        agentId: "agent1",
        applicationId: "app1",
        status: "success",
        cost: 0.5,
        duration: 1000,
        modelSource: "system",
      }),
    ).resolves.toBeUndefined();
  });

  it("afterRun broadcasts to ALL modules", async () => {
    const handlerA = mock(async () => {});
    const handlerB = mock(async () => {});

    const modA: AppstrateModule = {
      manifest: { id: "billing", name: "Billing", version: "1.0.0" },
      async init() {},
      events: { afterRun: handlerA },
    };
    const modB: AppstrateModule = {
      manifest: { id: "analytics", name: "Analytics", version: "1.0.0" },
      async init() {},
      events: { afterRun: handlerB },
    };

    await loadModulesFromInstances([modA, modB], mockCtx());

    const params = {
      orgId: "org1",
      runId: "run1",
      agentId: "agent1",
      applicationId: "app1",
      status: "success" as const,
      cost: 1.5,
      duration: 5000,
      modelSource: "openai",
    };
    await afterRun(params);

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerA).toHaveBeenCalledWith(params);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledWith(params);
  });

  it("afterRun isolates errors — one failing handler does not block others", async () => {
    const handlerA = mock(async () => {
      throw new Error("usage recording failed");
    });
    const handlerB = mock(async () => {});

    const modA: AppstrateModule = {
      manifest: { id: "billing", name: "Billing", version: "1.0.0" },
      async init() {},
      events: { afterRun: handlerA },
    };
    const modB: AppstrateModule = {
      manifest: { id: "analytics", name: "Analytics", version: "1.0.0" },
      async init() {},
      events: { afterRun: handlerB },
    };

    await loadModulesFromInstances([modA, modB], mockCtx());

    // Should not throw
    await afterRun({
      orgId: "org1",
      runId: "run1",
      agentId: "agent1",
      applicationId: "app1",
      status: "success",
      cost: 1.0,
      duration: 3000,
      modelSource: "system",
    });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Org lifecycle events
  // ---------------------------------------------------------------------------

  it("onOrgCreated is no-op when no module provides the event", async () => {
    await loadModulesFromInstances([], mockCtx());
    await expect(onOrgCreated("org1", "user@test.com")).resolves.toBeUndefined();
  });

  it("onOrgDeleted is no-op when no module provides the event", async () => {
    await loadModulesFromInstances([], mockCtx());
    await expect(onOrgDeleted("org1")).resolves.toBeUndefined();
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

  it("delegates org events to module handlers with correct args", async () => {
    const mockOnOrgCreated = mock(async () => {});
    const mockOnOrgDeleted = mock(async () => {});

    const mod: AppstrateModule = {
      manifest: { id: "billing", name: "Billing", version: "1.0.0" },
      async init() {},
      events: {
        onOrgCreated: mockOnOrgCreated,
        onOrgDeleted: mockOnOrgDeleted,
      },
    };

    await loadModulesFromInstances([mod], mockCtx());

    await onOrgCreated("org1", "admin@test.com");
    expect(mockOnOrgCreated).toHaveBeenCalledWith("org1", "admin@test.com");

    await onOrgDeleted("org2");
    expect(mockOnOrgDeleted).toHaveBeenCalledWith("org2");
  });
});
