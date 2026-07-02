// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildGuestConfig,
  buildKernelBootArgs,
  buildVmConfig,
  parseExitMarker,
  vmSizing,
} from "../../../../src/services/orchestrator/firecracker/vm-config.ts";
import { subnetForIndex } from "../../../../src/services/orchestrator/firecracker/subnet.ts";

const SUBNET = subnetForIndex("10.231.0.0/16", 7);

describe("buildKernelBootArgs", () => {
  it("wires static guest networking + the appstrate init", () => {
    const args = buildKernelBootArgs(SUBNET);
    expect(args).toContain(`ip=${SUBNET.guestIp}::${SUBNET.hostIp}:255.255.255.252::eth0:off`);
    expect(args).toContain("init=/sbin/appstrate-init");
    expect(args).toContain("console=ttyS0");
    // reboot=k panic=1: guest poweroff/panic must terminate the VMM.
    expect(args).toContain("reboot=k");
    expect(args).toContain("panic=1");
    // Host + guest firewalls are IPv4-only — the guest gets no v6 stack.
    expect(args).toContain("ipv6.disable=1");
  });
});

describe("buildVmConfig", () => {
  const config = buildVmConfig({
    kernelPath: "/data/vmlinux",
    rootfsPath: "/data/rootfs.ext4",
    configDrivePath: "/runs/run_1/config.img",
    bootArgs: "console=ttyS0",
    subnet: SUBNET,
    vcpuCount: 2,
    memSizeMib: 2048,
  });

  it("attaches the shared rootfs read-only", () => {
    const drives = config.drives as Array<Record<string, unknown>>;
    expect(drives[0]).toMatchObject({
      drive_id: "rootfs",
      is_root_device: true,
      is_read_only: true,
    });
  });

  it("attaches the config drive as a read-only secondary device", () => {
    const drives = config.drives as Array<Record<string, unknown>>;
    expect(drives[1]).toMatchObject({
      drive_id: "config",
      is_root_device: false,
      is_read_only: true,
      path_on_host: "/runs/run_1/config.img",
    });
  });

  it("binds eth0 to the run's TAP with the derived MAC", () => {
    const ifaces = config["network-interfaces"] as Array<Record<string, unknown>>;
    expect(ifaces).toEqual([
      { iface_id: "eth0", guest_mac: SUBNET.guestMac, host_dev_name: SUBNET.tapDevice },
    ]);
  });

  it("carries the machine sizing", () => {
    expect(config["machine-config"]).toEqual({ vcpu_count: 2, mem_size_mib: 2048 });
  });
});

describe("vmSizing", () => {
  it("adds the sidecar + system envelope to the agent budget", () => {
    const sizing = vmSizing({ memoryBytes: 1536 * 1024 * 1024, nanoCpus: 2_000_000_000 }, true);
    expect(sizing).toEqual({ vcpuCount: 3, memSizeMib: 1536 + 256 + 256 });
  });

  it("drops the sidecar envelope (RAM + extra vCPU) for skipSidecar runs", () => {
    const sizing = vmSizing({ memoryBytes: 1536 * 1024 * 1024, nanoCpus: 2_000_000_000 }, false);
    expect(sizing).toEqual({ vcpuCount: 2, memSizeMib: 1536 + 256 });
  });

  it("clamps vcpus to a sane range", () => {
    expect(vmSizing({ memoryBytes: 1, nanoCpus: 100 }, true).vcpuCount).toBe(2);
    expect(vmSizing({ memoryBytes: 1, nanoCpus: 100 }, false).vcpuCount).toBe(2);
    expect(vmSizing({ memoryBytes: 1, nanoCpus: 64_000_000_000 }, true).vcpuCount).toBe(8);
    expect(vmSizing({ memoryBytes: 1, nanoCpus: 64_000_000_000 }, false).vcpuCount).toBe(8);
  });
});

describe("buildGuestConfig", () => {
  it("marks the sidecar disabled when no env is provided (skipSidecar)", () => {
    const cfg = buildGuestConfig({
      runId: "run_1",
      exitMarkerNonce: "abc123",
      platformIp: "10.231.255.1",
      platformPort: 3000,
      agentEnv: { A: "1" },
      agentUnrestrictedEgress: true,
    });
    expect(cfg.sidecar).toEqual({ enabled: false, env: {} });
    expect(cfg.agent.unrestricted_egress).toBe(true);
    expect(cfg.agent.argv).toBeUndefined();
    expect(cfg.exit_marker_nonce).toBe("abc123");
  });

  it("carries sidecar env + restricted agent egress for sidecar-backed runs", () => {
    const cfg = buildGuestConfig({
      runId: "run_1",
      exitMarkerNonce: "abc123",
      platformIp: "10.231.255.1",
      platformPort: 3000,
      sidecarEnv: { RUN_TOKEN: "t" },
      agentEnv: {},
      agentUnrestrictedEgress: false,
    });
    expect(cfg.sidecar).toEqual({ enabled: true, env: { RUN_TOKEN: "t" } });
    expect(cfg.agent.unrestricted_egress).toBe(false);
    expect(cfg.network).toEqual({ platform_ip: "10.231.255.1", platform_port: 3000 });
  });
});

describe("parseExitMarker", () => {
  const NONCE = "d00dfeedd00dfeed";

  it("returns null when no marker is present", () => {
    expect(parseExitMarker("kernel panic\nsomething\n", NONCE)).toBeNull();
    expect(parseExitMarker("", NONCE)).toBeNull();
  });

  it("extracts the code from a nonce-authenticated marker", () => {
    expect(parseExitMarker(`boot ok\nAPPSTRATE_EXIT:${NONCE}:0\n`, NONCE)).toBe(0);
    expect(parseExitMarker(`x\nAPPSTRATE_EXIT:${NONCE}:137\n`, NONCE)).toBe(137);
  });

  it("takes the LAST marker when several are printed", () => {
    expect(
      parseExitMarker(`APPSTRATE_EXIT:${NONCE}:1\nnoise\nAPPSTRATE_EXIT:${NONCE}:0\n`, NONCE),
    ).toBe(0);
  });

  it("tolerates the marker embedded in a prefixed console line", () => {
    expect(parseExitMarker(`[  12.3] APPSTRATE_EXIT:${NONCE}:42 trailing`, NONCE)).toBe(42);
  });

  it("ignores forged markers without the nonce (killed run must not report success)", () => {
    // A workload pre-printing the legacy marker shape on the shared
    // console must not be able to fake a clean exit.
    expect(parseExitMarker("APPSTRATE_EXIT:0\n", NONCE)).toBeNull();
    expect(parseExitMarker("APPSTRATE_EXIT:wrongnonce:0\n", NONCE)).toBeNull();
  });

  it("ignores everything when the nonce is empty (never trust an unauthenticated marker)", () => {
    expect(parseExitMarker("APPSTRATE_EXIT::0\n", "")).toBeNull();
  });
});
