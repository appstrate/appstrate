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
 *     `apps/api/src/modules/firecracker/guest/supervisor.ts` inside the microVM.
 */

import { SUBNET_NETMASK, type RunSubnet } from "./subnet.ts";
// The config-drive wire contract is shared with its in-guest consumer —
// single definition next to the supervisor, imported type-only.
import type { GuestConfig } from "./guest/guest-config.ts";

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
  /**
   * Where the guest's secrets come from — `"mmds"` (broker; the drive env
   * maps are stripped of secret keys) or `"inline"` (drive carries them).
   * See {@link GuestConfig.credentials}.
   */
  credentialSource: "mmds" | "inline";
  /** Smoke-harness only — see GuestConfig.agent.argv. */
  agentArgv?: string[];
}

export function buildGuestConfig(input: BuildGuestConfigInput): GuestConfig {
  return {
    run_id: input.runId,
    credentials: { source: input.credentialSource },
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
    // Boot-latency trim: every kernel printk over the emulated 16550 UART
    // is a per-character VM exit. `quiet loglevel=1` silences boot chatter
    // (userspace writes — init/supervisor logs, the exit marker — are
    // unaffected); the i8042.* stubs skip PS/2 controller probing on
    // hardware Firecracker doesn't emulate; random.trust_cpu seeds the
    // CRNG from RDRAND so early boot never blocks on the entropy pool.
    "quiet",
    "loglevel=1",
    "i8042.noaux",
    "i8042.nomux",
    "i8042.nopnp",
    "i8042.dumbkbd",
    "random.trust_cpu=on",
    "reboot=k",
    "panic=1",
    "pci=off",
    // The host firewall (table `ip appstrate_fc`) and the in-guest uid
    // rules are IPv4-only — no IPv6 in the guest means no unfiltered v6
    // path to link-local host services.
    "ipv6.disable=1",
    `ip=${subnet.guestIp}::${subnet.hostIp}:${SUBNET_NETMASK}::eth0:off`,
    "init=/sbin/appstrate-init",
  ].join(" ");
}

export interface BuildVmConfigInput {
  /**
   * Path mapping is the CALLER's contract: host-absolute paths for a
   * direct (unjailed) spawn, chroot-relative paths (`/vmlinux`, …) for a
   * jailed spawn — firecracker resolves them after pivot_root. This
   * builder never resolves or rewrites them.
   */
  kernelPath: string;
  rootfsPath: string;
  configDrivePath: string;
  bootArgs: string;
  subnet: RunSubnet;
  vcpuCount: number;
  memSizeMib: number;
  /**
   * Add the MMDS config block (credential broker). When true the VMM
   * intercepts {@link MMDS_IPV4_ADDRESS} on `eth0` and serves the in-memory
   * data store the daemon PUTs post-boot — the guest supervisor fetches the
   * run's secrets from it (FIRECRACKER_CREDENTIAL_BROKER=mmds). Omitted for
   * the config-drive broker.
   */
  mmds?: boolean;
}

/** MMDS default link-local service address (Firecracker default). */
export const MMDS_IPV4_ADDRESS = "169.254.169.254";
/** The guest NIC MMDS is bound to — wired into the `network-interfaces` iface_id below. */
const MMDS_NETWORK_INTERFACE = "eth0";

/**
 * Per-device token-bucket rate limiters (Firecracker's dual-bucket
 * design: bytes + ops, each refilled per `refill_time` ms). These are
 * DoS bounds against a hostile guest flooding host I/O — not workload
 * QoS — so they are deliberately generous and not operator-tunable:
 *
 *   - drives: a large one-time burst lets the boot read the rootfs at
 *     full speed; the sustained rate only throttles a guest that keeps
 *     hammering the (read-only) block devices afterwards.
 *   - network: ~25 MiB/s sustained per direction with a burst allowance
 *     for legitimate downloads (package installs, artifact pulls).
 */
const DRIVE_RATE_LIMITER = {
  bandwidth: { size: 50 * 1024 * 1024, refill_time: 1000, one_time_burst: 1024 * 1024 * 1024 },
  ops: { size: 20_000, refill_time: 1000, one_time_burst: 100_000 },
};
const NET_RATE_LIMITER = {
  bandwidth: { size: 25 * 1024 * 1024, refill_time: 1000, one_time_burst: 200 * 1024 * 1024 },
  ops: { size: 50_000, refill_time: 1000, one_time_burst: 100_000 },
};

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
        rate_limiter: DRIVE_RATE_LIMITER,
      },
      {
        drive_id: "config",
        path_on_host: input.configDrivePath,
        is_root_device: false,
        is_read_only: true,
        rate_limiter: DRIVE_RATE_LIMITER,
      },
    ],
    "network-interfaces": [
      {
        iface_id: MMDS_NETWORK_INTERFACE,
        guest_mac: input.subnet.guestMac,
        host_dev_name: input.subnet.tapDevice,
        rx_rate_limiter: NET_RATE_LIMITER,
        tx_rate_limiter: NET_RATE_LIMITER,
      },
    ],
    "machine-config": {
      vcpu_count: input.vcpuCount,
      mem_size_mib: input.memSizeMib,
    },
    // Credential broker: V2 (session-token) MMDS on eth0. The daemon PUTs
    // the run's secrets to the in-memory store after boot; the guest
    // supervisor fetches them and then the guest firewall drops all further
    // access to MMDS_IPV4_ADDRESS. Absent for the config-drive broker.
    ...(input.mmds
      ? {
          "mmds-config": {
            version: "V2",
            network_interfaces: [MMDS_NETWORK_INTERFACE],
            ipv4_address: MMDS_IPV4_ADDRESS,
          },
        }
      : {}),
  };
}

/**
 * VM sizing from the agent's workload resources. The microVM hosts the
 * agent AND (usually) the sidecar (+ kernel/init overhead), so the guest
 * budget is the agent budget plus a fixed envelope. skipSidecar runs
 * (`hasSidecar: false`) drop the sidecar's share of that envelope.
 */
export function vmSizing(
  agent: { memoryBytes: number; nanoCpus: number },
  hasSidecar: boolean,
  supplemental: { memoryBytes: number; nanoCpus: number } = {
    memoryBytes: 0,
    nanoCpus: 0,
  },
): {
  vcpuCount: number;
  memSizeMib: number;
} {
  const agentMib = Math.ceil(agent.memoryBytes / (1024 * 1024));
  const supplementalMib = Math.ceil(supplemental.memoryBytes / (1024 * 1024));
  const sidecarMib = hasSidecar ? 256 : 0;
  const systemMib = 256; // kernel + init + tmpfs overlay headroom
  const vcpuFromSpec = Math.ceil(agent.nanoCpus / 1_000_000_000);
  const supplementalVcpus = Math.ceil(supplemental.nanoCpus / 1_000_000_000);
  return {
    // The sidecar and the agent cold-start concurrently — on a single
    // vCPU they starve each other and the agent's first sink event can
    // slip past the platform's heartbeat deadline. Budget one extra
    // vCPU for the sidecar (when there is one) and never go below two.
    vcpuCount: Math.min(8, Math.max(2, vcpuFromSpec + (hasSidecar ? 1 : 0) + supplementalVcpus)),
    memSizeMib: agentMib + sidecarMib + systemMib + supplementalMib,
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
  // The nonce is a daemon-generated random hex token (randomBytes(...).
  // toString("hex") in orchestrator.ts) — [0-9a-f] only, no regex
  // metacharacters — so it interpolates into the pattern directly.
  const marker = new RegExp(`APPSTRATE_EXIT:${nonce}:(\\d+)`);
  let last: number | null = null;
  for (const line of consoleTail.split("\n")) {
    const match = marker.exec(line);
    if (match) last = Number(match[1]);
  }
  return last;
}
