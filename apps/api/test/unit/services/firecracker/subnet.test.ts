// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  parseSubnetCidrBase,
  platformAliasIp,
  subnetForIndex,
  SubnetAllocator,
} from "../../../../src/services/orchestrator/firecracker/subnet.ts";

const CIDR = "10.231.0.0/16";

describe("parseSubnetCidrBase", () => {
  it("parses a valid /16", () => {
    expect(parseSubnetCidrBase("10.231.0.0/16")).toEqual([10, 231]);
    expect(parseSubnetCidrBase("172.28.0.0/16")).toEqual([172, 28]);
  });

  it("rejects malformed CIDRs", () => {
    expect(() => parseSubnetCidrBase("10.231.5.0/16")).toThrow();
    expect(() => parseSubnetCidrBase("10.231.0.0/24")).toThrow();
    expect(() => parseSubnetCidrBase("10.231.0.0")).toThrow();
    expect(() => parseSubnetCidrBase("300.1.0.0/16")).toThrow();
  });
});

describe("platformAliasIp", () => {
  it("lives in the reserved last /24 of the pool", () => {
    expect(platformAliasIp(CIDR)).toBe("10.231.255.1");
  });
});

describe("subnetForIndex", () => {
  it("computes the /30 block layout", () => {
    const s = subnetForIndex(CIDR, 1);
    expect(s.hostIp).toBe("10.231.0.5");
    expect(s.guestIp).toBe("10.231.0.6");
    expect(s.tapDevice).toBe("afc1");
    expect(s.netmask).toBe("255.255.255.252");
  });

  it("rolls the third octet every 64 blocks", () => {
    const s = subnetForIndex(CIDR, 64); // offset 256
    expect(s.hostIp).toBe("10.231.1.1");
    expect(s.guestIp).toBe("10.231.1.2");
  });

  it("derives a stable, unique MAC per index", () => {
    expect(subnetForIndex(CIDR, 1).guestMac).toBe("06:00:ac:00:00:01");
    expect(subnetForIndex(CIDR, 0x1ff).guestMac).toBe("06:00:ac:00:01:ff");
    expect(subnetForIndex(CIDR, 2).guestMac).not.toBe(subnetForIndex(CIDR, 3).guestMac);
  });

  it("never collides with the reserved alias /24", () => {
    // Highest allowed index stays below the x.y.255.0/24 range.
    const top = subnetForIndex(CIDR, 16319);
    expect(top.hostIp).toBe("10.231.254.253");
  });

  it("rejects out-of-range indexes", () => {
    expect(() => subnetForIndex(CIDR, 0)).toThrow();
    expect(() => subnetForIndex(CIDR, 16320)).toThrow();
    expect(() => subnetForIndex(CIDR, 1.5)).toThrow();
  });
});

describe("SubnetAllocator", () => {
  it("allocates unique blocks and reuses released ones", () => {
    const alloc = new SubnetAllocator(CIDR);
    const a = alloc.allocate();
    const b = alloc.allocate();
    expect(a.index).not.toBe(b.index);
    alloc.release(a.index);
    // The freed index becomes allocatable again (after the cursor wraps).
    const seen = new Set<number>([b.index]);
    let reused = false;
    for (let i = 0; i < 20000; i++) {
      const s = alloc.allocate();
      if (s.index === a.index) {
        reused = true;
        break;
      }
      expect(seen.has(s.index)).toBe(false);
      seen.add(s.index);
    }
    expect(reused).toBe(true);
  });

  it("throws when the pool is exhausted", () => {
    const alloc = new SubnetAllocator(CIDR);
    for (let i = 1; i <= 16319; i++) alloc.allocate();
    expect(() => alloc.allocate()).toThrow(/exhausted/);
  });
});
