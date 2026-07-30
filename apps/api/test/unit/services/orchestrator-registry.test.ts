// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the SECURITY capabilities each core backend declares, and the
 * registration invariants that replaced the old compile-time-closed
 * table: duplicate ids are fatal, unknown ids degrade fail-closed.
 * Module-contributed backends (e.g. firecracker) pin their own
 * capabilities in their module's test suite — core has zero knowledge
 * of them.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  orchestratorIsolatesWorkloads,
  orchestratorAgentResources,
  orchestratorSupportsSidecarOnly,
  isolatingOrchestratorIds,
  registerOrchestrator,
  selectOrchestrator,
  _resetOrchestratorRegistryForTesting,
} from "../../../src/services/orchestrator/registry.ts";
import type { RunOrchestrator } from "@appstrate/core/platform-types";

const fakeOrchestrator = {} as RunOrchestrator;

// Preload can leave module backends registered; teardown prevents our fakes
// from leaking to sibling files in Bun's shared test process.
beforeEach(() => {
  _resetOrchestratorRegistryForTesting();
});

afterEach(() => {
  _resetOrchestratorRegistryForTesting();
});

describe("orchestrator registry capabilities", () => {
  it("docker isolates workloads; process does not", () => {
    expect(orchestratorIsolatesWorkloads("docker")).toBe(true);
    expect(orchestratorIsolatesWorkloads("process")).toBe(false);
    expect(isolatingOrchestratorIds()).toEqual(["docker"]);
  });

  it("both core backends can run sidecar-only workloads (connect-runs)", () => {
    expect(orchestratorSupportsSidecarOnly("docker")).toBe(true);
    expect(orchestratorSupportsSidecarOnly("process")).toBe(true);
  });

  it("docker declares hard resource limits; process declares no resource semantics", () => {
    expect(orchestratorAgentResources("docker")).toEqual({ semantics: "limits" });
    expect(orchestratorAgentResources("process")).toBeUndefined();
  });

  it("unknown ids degrade fail-closed (no capability)", () => {
    expect(orchestratorIsolatesWorkloads("no-such-backend")).toBe(false);
    expect(orchestratorSupportsSidecarOnly("no-such-backend")).toBe(false);
    expect(orchestratorAgentResources("no-such-backend")).toBeUndefined();
  });
});

describe("orchestrator registration", () => {
  it("registered backends resolve and expose their declared capabilities", () => {
    registerOrchestrator(
      "fake-isolated",
      {
        isolatesWorkloads: true,
        supportsSidecarOnly: false,
        agentResources: {
          semantics: "sizing",
          maxAgentCpu: 5,
          writableRootTmpfsPercent: 25,
        },
        create: () => fakeOrchestrator,
      },
      "test",
    );
    expect(orchestratorIsolatesWorkloads("fake-isolated")).toBe(true);
    expect(orchestratorSupportsSidecarOnly("fake-isolated")).toBe(false);
    expect(orchestratorAgentResources("fake-isolated")).toEqual({
      semantics: "sizing",
      maxAgentCpu: 5,
      writableRootTmpfsPercent: 25,
    });
    expect(isolatingOrchestratorIds()).toEqual(["docker", "fake-isolated"]);
    expect(selectOrchestrator("fake-isolated")).toBe(fakeOrchestrator);
  });

  it("a duplicate id is fatal and names both owners", () => {
    expect(() =>
      registerOrchestrator(
        "docker",
        { isolatesWorkloads: false, supportsSidecarOnly: false, create: () => fakeOrchestrator },
        "rogue-module",
      ),
    ).toThrow(/"core" and "rogue-module" both declared orchestrator "docker"/);
    // The original registration survives untouched.
    expect(orchestratorIsolatesWorkloads("docker")).toBe(true);
  });

  for (const invalidMaxAgentCpu of [
    0,
    -1,
    1.5,
    Number.NaN,
    Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000_000) + 1,
  ]) {
    it(`rejects maxAgentCpu=${String(invalidMaxAgentCpu)}`, () => {
      expect(() =>
        registerOrchestrator(
          "invalid-resources",
          {
            isolatesWorkloads: true,
            supportsSidecarOnly: false,
            agentResources: { semantics: "sizing", maxAgentCpu: invalidMaxAgentCpu },
            create: () => fakeOrchestrator,
          },
          "broken-module",
        ),
      ).toThrow(/maxAgentCpu must be a positive safe integer/);
    });
  }

  for (const invalidWritableRootTmpfsPercent of [0, 101, 1.5, Number.NaN]) {
    it(`rejects writableRootTmpfsPercent=${String(invalidWritableRootTmpfsPercent)}`, () => {
      expect(() =>
        registerOrchestrator(
          "invalid-resources",
          {
            isolatesWorkloads: true,
            supportsSidecarOnly: false,
            agentResources: {
              semantics: "sizing",
              writableRootTmpfsPercent: invalidWritableRootTmpfsPercent,
            },
            create: () => fakeOrchestrator,
          },
          "broken-module",
        ),
      ).toThrow(/writableRootTmpfsPercent must be a safe integer from 1 to 100/);
    });
  }

  it("rejects unknown resource semantics at the runtime boundary", () => {
    expect(() =>
      registerOrchestrator(
        "invalid-resources",
        {
          isolatesWorkloads: true,
          supportsSidecarOnly: false,
          agentResources: { semantics: "advisory" },
          create: () => fakeOrchestrator,
        } as unknown as Parameters<typeof registerOrchestrator>[1],
        "broken-module",
      ),
    ).toThrow(/semantics must be "limits" or "sizing"/);
  });

  it("selecting an unregistered id fails with the registered list and a MODULES hint", () => {
    expect(() => selectOrchestrator("no-such-backend")).toThrow(
      /Unknown RUN_ADAPTER "no-such-backend" — registered orchestrators: docker, process/,
    );
  });
});
