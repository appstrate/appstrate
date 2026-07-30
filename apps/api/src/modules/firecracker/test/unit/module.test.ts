// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the SECURITY capabilities the firecracker module declares on its
 * orchestrator contribution — a capability flip must show up as an
 * explicit test change (the subscription-run policy and connect-runs
 * both key off these flags).
 */

import { describe, it, expect } from "bun:test";
import firecrackerModule from "../../index.ts";
import { vmSizing } from "../../vm-config.ts";

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
    expect(registration?.agentResources).toEqual({
      semantics: "sizing",
      maxAgentCpu: 7,
      writableRootTmpfsPercent: 50,
    });
  });

  it("keeps the declared agent CPU maximum below the VM cap when a sidecar is present", () => {
    const maxAgentCpu =
      firecrackerModule.orchestrators?.()?.firecracker?.agentResources?.maxAgentCpu;
    expect(maxAgentCpu).toBe(7);
    if (maxAgentCpu === undefined) throw new Error("missing Firecracker agent CPU maximum");

    expect(
      vmSizing({ memoryBytes: 1, nanoCpus: maxAgentCpu * 1_000_000_000 }, true).vcpuCount,
    ).toBe(8);
  });

  it("keeps the declared writable-root tmpfs budget in sync with guest init", async () => {
    const guestInit = await Bun.file(new URL("../../guest/init.sh", import.meta.url)).text();
    const mountPercent = guestInit.match(
      /mount -t tmpfs -o [^\n]*size=(\d+)% tmpfs \/overlay/,
    )?.[1];
    if (mountPercent === undefined) {
      throw new Error("guest init no longer declares the /overlay tmpfs percentage");
    }

    expect(
      firecrackerModule.orchestrators?.()?.firecracker?.agentResources?.writableRootTmpfsPercent,
    ).toBe(Number(mountPercent));
  });
});
