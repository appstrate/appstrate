// SPDX-License-Identifier: Apache-2.0

/**
 * Merge hook (`callMergeHook`) semantics.
 *
 * Proves that multiple modules contributing `enrichRun` patches are
 * shallow-merged per run id, that errors in one module are isolated from
 * others, and that a missing hook is a no-op.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { AppstrateModule, EnrichRunInput, ModuleInitContext } from "@appstrate/core/module";
import {
  loadModulesFromInstances,
  callMergeHook,
  resetModules,
} from "../../../src/lib/modules/module-loader.ts";

function mockCtx(): ModuleInitContext {
  return {
    databaseUrl: null,
    redisUrl: null,
    appUrl: "http://localhost:3000",
    isEmbeddedDb: true,
    applyMigrations: async () => {},
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
  };
}

function enrichModule(
  id: string,
  handler: (runs: readonly EnrichRunInput[]) => Record<string, Record<string, unknown>>,
): AppstrateModule {
  return {
    manifest: { id, name: id, version: "1.0.0" },
    async init() {},
    hooks: {
      enrichRun: async (runs) => handler(runs),
    },
  };
}

const sampleRuns: readonly EnrichRunInput[] = [
  { id: "run_a", scheduleId: "sched_1", orgId: "o", applicationId: "app", packageId: "pkg" },
  { id: "run_b", scheduleId: null, orgId: "o", applicationId: "app", packageId: "pkg" },
];

describe("callMergeHook(enrichRun)", () => {
  beforeEach(() => {
    resetModules();
  });

  it("returns an empty object when no module provides the hook", async () => {
    const nonContributing: AppstrateModule = {
      manifest: { id: "inert", name: "inert", version: "1.0.0" },
      async init() {},
    };
    await loadModulesFromInstances([nonContributing], mockCtx());
    const result = await callMergeHook("enrichRun", sampleRuns);
    expect(result).toEqual({});
  });

  it("shallow-merges patches from multiple modules per run id", async () => {
    const scheduling = enrichModule("scheduling", () => ({
      run_a: { scheduleName: "Daily sync" },
    }));
    const billing = enrichModule("billing", () => ({
      run_a: { billedAmount: 0.042 },
      run_b: { billedAmount: 0.01 },
    }));

    await loadModulesFromInstances([scheduling, billing], mockCtx());

    const result = await callMergeHook("enrichRun", sampleRuns);
    expect(result).toEqual({
      run_a: { scheduleName: "Daily sync", billedAmount: 0.042 },
      run_b: { billedAmount: 0.01 },
    });
  });

  it("isolates errors — a failing module does not block contributions from others", async () => {
    const failing = enrichModule("failing", () => {
      throw new Error("boom");
    });
    const working = enrichModule("working", () => ({
      run_a: { scheduleName: "OK" },
    }));

    await loadModulesFromInstances([failing, working], mockCtx());

    const result = await callMergeHook("enrichRun", sampleRuns);
    expect(result).toEqual({ run_a: { scheduleName: "OK" } });
  });

  it("last module wins on conflicting keys for the same run", async () => {
    const first = enrichModule("first", () => ({ run_a: { label: "from-first" } }));
    const second = enrichModule("second", () => ({ run_a: { label: "from-second" } }));

    await loadModulesFromInstances([first, second], mockCtx());

    const result = await callMergeHook("enrichRun", sampleRuns);
    expect(result.run_a).toEqual({ label: "from-second" });
  });
});
