// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the SECURITY capabilities the firecracker module declares on its
 * orchestrator contribution — a capability flip must show up as an
 * explicit test change (the subscription-run policy and connect-runs
 * both key off these flags).
 */

import { describe, it, expect } from "bun:test";
import firecrackerModule from "../../index.ts";

describe("firecracker module orchestrator contribution", () => {
  it("contributes exactly the single 'firecracker' backend", () => {
    const contributed = firecrackerModule.orchestrators?.();
    expect(contributed).toBeDefined();
    expect(Object.keys(contributed ?? {})).toEqual(["firecracker"]);
  });

  it("firecracker isolates workloads (microVM on the runner host — credentials never enter this API process) but cannot run sidecar-only workloads", () => {
    const registration = firecrackerModule.orchestrators?.()?.firecracker;
    expect(registration?.isolatesWorkloads).toBe(true);
    expect(registration?.supportsSidecarOnly).toBe(false);
  });
});
