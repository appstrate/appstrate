// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run /30 subnet allocation inside the FIRECRACKER_SUBNET_CIDR /16
 * pool. Pure arithmetic + an in-memory allocator — no host commands.
 *
 * Layout of one /30 block (index n, base a.b.0.0/16):
 *   network   a.b.(n*4 >> 8).((n*4) & 0xff)
 *   host TAP  network + 1   (the platform side of the veth-like pair)
 *   guest     network + 2
 *   broadcast network + 3
 *
 * Index 0 is reserved: its block contains a.b.0.1 which reads like a
 * "gateway of the whole pool" and is easy to misconfigure against; the
 * last /24 (indexes with third octet 255) is reserved for well-known
 * platform addresses (the loopback alias the guests use to reach the
 * platform API).
 */

export interface RunSubnet {
  /** Allocator index — stable identity for the run's network resources. */
  readonly index: number;
  /** Host-side TAP device name, e.g. `afc12` (≤15 chars, kernel IFNAMSIZ). */
  readonly tapDevice: string;
  /** Host-side IP of the TAP (the guest's default gateway). */
  readonly hostIp: string;
  /** Guest eth0 IP. */
  readonly guestIp: string;
  /** Deterministic guest MAC derived from the index. */
  readonly guestMac: string;
}

export const TAP_DEVICE_PREFIX = "afc";

/** Netmask of every /30 block (a fixed invariant of the allocation). */
export const SUBNET_NETMASK = "255.255.255.252";

/** Highest usable index: /16 holds 16384 /30 blocks; keep the last /24 (indexes 16320+) reserved. */
const MAX_INDEX = 16319;

/** Parse and validate the `a.b.0.0/16` pool base, returning `[a, b]`. */
export function parseSubnetCidrBase(cidr: string): [number, number] {
  const match = /^(\d+)\.(\d+)\.0\.0\/16$/.exec(cidr);
  if (!match) {
    throw new Error(`FIRECRACKER_SUBNET_CIDR must look like "10.231.0.0/16", got "${cidr}"`);
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a > 255 || b > 255) {
    throw new Error(`FIRECRACKER_SUBNET_CIDR octets out of range: "${cidr}"`);
  }
  return [a, b];
}

/**
 * Well-known host address guests use to reach the platform API. Lives in
 * the pool's reserved last /24 and is bound to the host loopback as a
 * /32 alias — every guest routes to it through its own /30 gateway.
 */
export function platformAliasIp(cidr: string): string {
  const [a, b] = parseSubnetCidrBase(cidr);
  return `${a}.${b}.255.1`;
}

export function subnetForIndex(cidr: string, index: number): RunSubnet {
  if (!Number.isInteger(index) || index < 1 || index > MAX_INDEX) {
    throw new Error(`Firecracker subnet index out of range: ${index}`);
  }
  const [a, b] = parseSubnetCidrBase(cidr);
  const offset = index * 4;
  const oct3 = offset >> 8;
  const oct4 = offset & 0xff;
  return {
    index,
    tapDevice: `${TAP_DEVICE_PREFIX}${index}`,
    hostIp: `${a}.${b}.${oct3}.${oct4 + 1}`,
    guestIp: `${a}.${b}.${oct3}.${oct4 + 2}`,
    // Locally-administered, unicast prefix 06 (mirrors the Firecracker
    // getting-started convention) + the index spread over the low bytes.
    guestMac: `06:00:ac:00:${hex(index >> 8)}:${hex(index & 0xff)}`,
  };
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * In-memory index allocator. Crash recovery does not need persistence:
 * the boot-time orphan sweep deletes every `afc*` TAP device, so a fresh
 * process can safely restart from an empty set.
 */
export class SubnetAllocator {
  private readonly inUse = new Set<number>();

  constructor(private readonly cidr: string) {}

  /**
   * Lowest-free scan, NOT round-robin: the index also derives the run's
   * jail uid (FIRECRACKER_JAIL_UID_BASE + index), so it must stay bounded
   * by the number of CONCURRENT runs — a round-robin cursor walks the
   * whole 1..16319 space over the host's lifetime and eventually hands
   * out uids colliding with foreign uid ranges. Immediate reuse is safe:
   * an index is only released after its TAP device is confirmed deleted.
   */
  allocate(): RunSubnet {
    for (let candidate = 1; candidate <= MAX_INDEX; candidate++) {
      if (!this.inUse.has(candidate)) {
        this.inUse.add(candidate);
        return subnetForIndex(this.cidr, candidate);
      }
    }
    throw new Error("Firecracker subnet pool exhausted (16k concurrent runs)");
  }

  release(index: number): void {
    this.inUse.delete(index);
  }
}
