// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the SECURITY capabilities each core backend declares, and the
 * registration invariants that replaced the old compile-time-closed
 * table: duplicate ids are fatal, unknown ids degrade fail-closed.
 * Module-contributed backends (e.g. firecracker) pin their own
 * capabilities in their module's test suite — core has zero knowledge
 * of them.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  orchestratorIsolatesWorkloads,
  orchestratorSupportsSidecarOnly,
  isolatingOrchestratorIds,
  registerOrchestrator,
  selectOrchestrator,
  _resetOrchestratorRegistryForTesting,
} from "../../../src/services/orchestrator/registry.ts";
import type { RunOrchestrator } from "@appstrate/core/platform-types";

const fakeOrchestrator = {} as RunOrchestrator;

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

  it("unknown ids degrade fail-closed (no capability)", () => {
    expect(orchestratorIsolatesWorkloads("no-such-backend")).toBe(false);
    expect(orchestratorSupportsSidecarOnly("no-such-backend")).toBe(false);
  });
});

describe("orchestrator registration", () => {
  it("registered backends resolve and expose their declared capabilities", () => {
    registerOrchestrator(
      "fake-isolated",
      { isolatesWorkloads: true, supportsSidecarOnly: false, create: () => fakeOrchestrator },
      "test",
    );
    expect(orchestratorIsolatesWorkloads("fake-isolated")).toBe(true);
    expect(orchestratorSupportsSidecarOnly("fake-isolated")).toBe(false);
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

  it("selecting an unregistered id fails with the registered list and a MODULES hint", () => {
    expect(() => selectOrchestrator("no-such-backend")).toThrow(
      /Unknown RUN_ADAPTER "no-such-backend" — registered orchestrators: docker, process/,
    );
  });
});
