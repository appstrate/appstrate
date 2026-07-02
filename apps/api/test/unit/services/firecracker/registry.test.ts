// SPDX-License-Identifier: Apache-2.0

/**
 * The registry is a closed compile-time table (`RUN_ADAPTER` is a closed
 * Zod enum) — these tests pin the SECURITY capabilities each backend
 * declares, so a capability flip shows up as an explicit test change.
 */

import { describe, it, expect } from "bun:test";
import {
  orchestratorIsolatesWorkloads,
  orchestratorSupportsSidecarOnly,
  isolatingOrchestratorIds,
} from "../../../../src/services/orchestrator/registry.ts";

describe("orchestrator registry capabilities", () => {
  it("docker and firecracker isolate workloads; process does not", () => {
    expect(orchestratorIsolatesWorkloads("docker")).toBe(true);
    expect(orchestratorIsolatesWorkloads("firecracker")).toBe(true);
    expect(orchestratorIsolatesWorkloads("process")).toBe(false);
    expect(isolatingOrchestratorIds()).toEqual(["docker", "firecracker"]);
  });

  it("firecracker cannot run sidecar-only workloads (connect-runs fail fast)", () => {
    expect(orchestratorSupportsSidecarOnly("docker")).toBe(true);
    expect(orchestratorSupportsSidecarOnly("process")).toBe(true);
    expect(orchestratorSupportsSidecarOnly("firecracker")).toBe(false);
  });
});
