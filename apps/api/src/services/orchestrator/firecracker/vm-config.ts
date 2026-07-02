// SPDX-License-Identifier: Apache-2.0

/**
 * Pure builders for the per-run Firecracker machine configuration, the
 * guest kernel command line, and the guest supervisor config. No I/O —
 * everything here is unit-testable without KVM.
 *
 * Wire shapes:
 *   - The Firecracker `--config-file` JSON follows the Firecracker API
 *     schema (their casing, e.g. `kernel_image_path`).
 *   - The guest config (`config.json` on the config drive) is an
 *     Appstrate wire format → snake_case, consumed by
 *     `runtime-pi/guest/supervisor.ts` inside the microVM.
 */

import type { RunSubnet } from "./subnet.ts";
// The config-drive wire contract is shared with its in-guest consumer —
// single definition next to the supervisor, imported type-only.
import type {
  GuestConfig,
  GuestNetworkConfig,
} from "../../../../../../runtime-pi/guest/guest-config.ts";

export type { GuestConfig, GuestNetworkConfig };

export interface BuildGuestConfigInput {
  runId: string;
  /** Per-run random nonce authenticating the exit marker (see GuestConfig). */
  exitMarkerNonce: string;
  platformIp: string;
  platformPort: number;
  /** Absent for skipSidecar runs. */
  sidecarEnv?: Record<string, string>;
  agentEnv: Record<string, string>;
  agentUnrestrictedEgress: boolean;
  /** Smoke-harness only — see GuestConfig.agent.argv. */
  agentArgv?: string[];
}

export function buildGuestConfig(input: BuildGuestConfigInput): GuestConfig {
  return {
    run_id: input.runId,
    exit_marker_nonce: input.exitMarkerNonce,
    network: { platform_ip: input.platformIp, platform_port: input.platformPort },
    sidecar: { enabled: !!input.sidecarEnv, env: input.sidecarEnv ?? {} },
    agent: {
      env: input.agentEnv,
      unrestricted_egress: input.agentUnrestrictedEgress,
      ...(input.agentArgv ? { argv: input.agentArgv } : {}),
    },
  };
}

/**
 * Kernel command line. `ip=` wires eth0 statically before userspace runs
 * (no DHCP in the guest); `init=` hands PID 1 to the Appstrate guest init,
 * which sets up the tmpfs overlay and executes the supervisor.
 * `reboot=k panic=1` make any guest reboot/panic terminate the VMM
 * process — the platform's `waitForExit` observes that as run completion.
 */
export function buildKernelBootArgs(subnet: RunSubnet): string {
  return [
    "console=ttyS0",
    "reboot=k",
    "panic=1",
    "pci=off",
    // The host firewall (table `ip appstrate_fc`) and the in-guest uid
    // rules are IPv4-only — no IPv6 in the guest means no unfiltered v6
    // path to link-local host services.
    "ipv6.disable=1",
    `ip=${subnet.guestIp}::${subnet.hostIp}:${subnet.netmask}::eth0:off`,
    "init=/sbin/appstrate-init",
  ].join(" ");
}

export interface BuildVmConfigInput {
  kernelPath: string;
  rootfsPath: string;
  configDrivePath: string;
  bootArgs: string;
  subnet: RunSubnet;
  vcpuCount: number;
  memSizeMib: number;
}

/** Firecracker `--config-file` payload (Firecracker API casing). */
export function buildVmConfig(input: BuildVmConfigInput): Record<string, unknown> {
  return {
    "boot-source": {
      kernel_image_path: input.kernelPath,
      boot_args: input.bootArgs,
    },
    drives: [
      {
        drive_id: "rootfs",
        path_on_host: input.rootfsPath,
        is_root_device: true,
        // The rootfs file is SHARED by every concurrent run — it must be
        // attached read-only; the guest init overlays a tmpfs on top for
        // per-run writes.
        is_read_only: true,
      },
      {
        drive_id: "config",
        path_on_host: input.configDrivePath,
        is_root_device: false,
        is_read_only: true,
      },
    ],
    "network-interfaces": [
      {
        iface_id: "eth0",
        guest_mac: input.subnet.guestMac,
        host_dev_name: input.subnet.tapDevice,
      },
    ],
    "machine-config": {
      vcpu_count: input.vcpuCount,
      mem_size_mib: input.memSizeMib,
    },
  };
}

/**
 * VM sizing from the agent's workload resources. The microVM hosts the
 * agent AND the sidecar (+ kernel/init overhead), so the guest budget is
 * the agent budget plus a fixed envelope.
 */
export function vmSizing(agent: { memoryBytes: number; nanoCpus: number }): {
  vcpuCount: number;
  memSizeMib: number;
} {
  const agentMib = Math.ceil(agent.memoryBytes / (1024 * 1024));
  const sidecarMib = 256;
  const systemMib = 256; // kernel + init + tmpfs overlay headroom
  const vcpuFromSpec = Math.ceil(agent.nanoCpus / 1_000_000_000);
  return {
    // The sidecar and the agent cold-start concurrently — on a single
    // vCPU they starve each other and the agent's first sink event can
    // slip past the platform's heartbeat deadline. Budget one extra
    // vCPU for the sidecar and never go below two.
    vcpuCount: Math.min(8, Math.max(2, vcpuFromSpec + 1)),
    memSizeMib: agentMib + sidecarMib + systemMib,
  };
}

/**
 * Extract the guest's exit code from the tail of the serial console log.
 * The supervisor prints `APPSTRATE_EXIT:<nonce>:<code>` as its last line
 * before powering the VM off. Only markers carrying THIS run's nonce
 * count: the serial console is shared with workload stdout, so an
 * un-nonced (or wrong-nonce) marker is a potential forgery and is
 * ignored — the caller then falls back to its killed/crashed handling.
 */
export function parseExitMarker(consoleTail: string, nonce: string): number | null {
  if (nonce.length === 0) return null;
  const marker = new RegExp(`APPSTRATE_EXIT:${escapeRegExp(nonce)}:(\\d+)`);
  let last: number | null = null;
  for (const line of consoleTail.split("\n")) {
    const match = marker.exec(line);
    if (match) last = Number(match[1]);
  }
  return last;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
