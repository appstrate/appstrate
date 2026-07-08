// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  isBlockedHost,
  isBlockedUrl,
  resolveAndCheckHost,
  type HostResolver,
} from "../src/ssrf.ts";

describe("isBlockedHost", () => {
  it("blocks localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
  });

  it("blocks Docker internal hostnames", () => {
    expect(isBlockedHost("sidecar")).toBe(true);
    expect(isBlockedHost("agent")).toBe(true);
    expect(isBlockedHost("host.docker.internal")).toBe(true);
  });

  it("blocks cloud metadata service", () => {
    expect(isBlockedHost("metadata.google.internal")).toBe(true);
  });

  it("blocks IPv4 loopback range", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("127.255.255.255")).toBe(true);
  });

  it("blocks private IPv4 ranges", () => {
    expect(isBlockedHost("10.0.0.1")).toBe(true);
    expect(isBlockedHost("10.255.255.255")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
    expect(isBlockedHost("192.168.0.1")).toBe(true);
    expect(isBlockedHost("192.168.255.255")).toBe(true);
  });

  it("blocks link-local", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  it("blocks 0.0.0.0/8", () => {
    expect(isBlockedHost("0.0.0.0")).toBe(true);
  });

  it("blocks 100.64.0.0/10 (CGN + Alibaba/Tencent cloud metadata)", () => {
    expect(isBlockedHost("100.100.100.200")).toBe(true); // Alibaba/Tencent metadata
    expect(isBlockedHost("100.64.0.1")).toBe(true);
    expect(isBlockedHost("100.127.255.255")).toBe(true);
    expect(isBlockedHost("100.63.255.255")).toBe(false); // just below the range
    expect(isBlockedHost("100.128.0.0")).toBe(false); // just above the range
  });

  it("blocks reserved / benchmark / multicast ranges", () => {
    expect(isBlockedHost("198.18.0.1")).toBe(true); // 198.18.0.0/15 benchmark
    expect(isBlockedHost("192.0.0.1")).toBe(true); // 192.0.0.0/24 IETF protocol
    expect(isBlockedHost("224.0.0.1")).toBe(true); // multicast
    expect(isBlockedHost("240.0.0.1")).toBe(true); // reserved
    expect(isBlockedHost("255.255.255.255")).toBe(true); // broadcast
  });

  it("allows public IPs", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("172.15.0.1")).toBe(false);
    expect(isBlockedHost("172.32.0.1")).toBe(false);
    expect(isBlockedHost("100.63.0.1")).toBe(false);
    expect(isBlockedHost("101.0.0.1")).toBe(false);
  });

  it("allows public hostnames", () => {
    expect(isBlockedHost("api.example.com")).toBe(false);
  });

  it("blocks numeric IP bypass", () => {
    expect(isBlockedHost("2130706433")).toBe(true); // 127.0.0.1 as decimal
  });

  it("blocks hex IP bypass", () => {
    expect(isBlockedHost("0x7f000001")).toBe(true); // 127.0.0.1 as hex
  });

  it("blocks IPv6 loopback", () => {
    expect(isBlockedHost("::1")).toBe(true);
    expect(isBlockedHost("::")).toBe(true);
  });

  it("blocks IPv6 link-local", () => {
    expect(isBlockedHost("fe80::1")).toBe(true);
  });

  it("blocks IPv6 unique local", () => {
    expect(isBlockedHost("fc00::1")).toBe(true);
    expect(isBlockedHost("fd00::1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6", () => {
    expect(isBlockedHost("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isBlockedHost("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isBlockedHost("::ffff:0808:0808")).toBe(false); // 8.8.8.8
  });

  it("blocks trailing-dot FQDN bypass", () => {
    // A trailing dot resolves identically in DNS but used to slip past the
    // exact-string and dotted-IP checks.
    expect(isBlockedHost("localhost.")).toBe(true);
    expect(isBlockedHost("metadata.google.internal.")).toBe(true);
    expect(isBlockedHost("host.docker.internal.")).toBe(true);
    expect(isBlockedHost("127.0.0.1.")).toBe(true);
    expect(isBlockedHost("169.254.169.254.")).toBe(true);
    expect(isBlockedUrl("http://metadata.google.internal./computeMetadata/v1/")).toBe(true);
  });

  it("blocks unparseable hostname", () => {
    expect(isBlockedHost("")).toBe(true);
  });

  it("handles bracketed IPv6", () => {
    expect(isBlockedHost("[2001:db8::1]")).toBe(false);
  });
});

describe("isBlockedUrl", () => {
  it("blocks non-http schemes", () => {
    expect(isBlockedUrl("ftp://example.com/file")).toBe(true);
    expect(isBlockedUrl("file:///etc/passwd")).toBe(true);
  });

  it("blocks private IPs", () => {
    expect(isBlockedUrl("http://127.0.0.1/admin")).toBe(true);
  });

  it("allows public HTTPS", () => {
    expect(isBlockedUrl("https://api.example.com/v1")).toBe(false);
  });

  it("allows public HTTP", () => {
    expect(isBlockedUrl("http://api.example.com/v1")).toBe(false);
  });

  it("blocks malformed URLs", () => {
    expect(isBlockedUrl("not-a-url")).toBe(true);
  });
});

describe("resolveAndCheckHost", () => {
  const resolvesTo =
    (...addrs: string[]): HostResolver =>
    async () =>
      addrs;
  const throws: HostResolver = async () => {
    throw new Error("resolution failed");
  };

  it("blocks an internal IP literal without consulting DNS", async () => {
    let called = false;
    const spy: HostResolver = async (h) => {
      called = true;
      return [h];
    };
    const res = await resolveAndCheckHost("169.254.169.254", { resolve: spy });
    expect(res).toEqual({ blocked: true, reason: "blocked-literal" });
    expect(called).toBe(false);
  });

  it("pins a public IP literal to itself without consulting DNS", async () => {
    let called = false;
    const spy: HostResolver = async (h) => {
      called = true;
      return [h];
    };
    const res = await resolveAndCheckHost("8.8.8.8", { resolve: spy });
    expect(res).toEqual({ blocked: false, pinnedAddress: "8.8.8.8" });
    expect(called).toBe(false);
  });

  it("strips IPv6 brackets and pins the bare address", async () => {
    const res = await resolveAndCheckHost("[2001:db8::1]", { resolve: throws });
    expect(res).toEqual({ blocked: false, pinnedAddress: "2001:db8::1" });
  });

  it("blocks a known-internal hostname without consulting DNS", async () => {
    const res = await resolveAndCheckHost("metadata.google.internal", { resolve: throws });
    expect(res).toEqual({ blocked: true, reason: "blocked-literal" });
  });

  it("blocks a public name that RESOLVES to a private address (rebind)", async () => {
    const res = await resolveAndCheckHost("evil.example", {
      resolve: resolvesTo("169.254.169.254"),
    });
    expect(res).toEqual({ blocked: true, reason: "blocked-resolved" });
  });

  it("blocks when ANY resolved address is private (mixed records)", async () => {
    const res = await resolveAndCheckHost("evil.example", {
      resolve: resolvesTo("93.184.216.34", "10.0.0.5"),
    });
    expect(res).toEqual({ blocked: true, reason: "blocked-resolved" });
  });

  it("blocks an IPv4-mapped-IPv6 resolution to loopback", async () => {
    const res = await resolveAndCheckHost("evil.example", {
      resolve: resolvesTo("::ffff:127.0.0.1"),
    });
    expect(res).toEqual({ blocked: true, reason: "blocked-resolved" });
  });

  it("pins an allowed name to a resolved address, preferring IPv4", async () => {
    const res = await resolveAndCheckHost("api.example.com", {
      resolve: resolvesTo("2606:2800:220:1::1", "93.184.216.34"),
    });
    expect(res).toEqual({ blocked: false, pinnedAddress: "93.184.216.34" });
  });

  it("pins to the first address when only AAAA records resolve", async () => {
    const res = await resolveAndCheckHost("api.example.com", {
      resolve: resolvesTo("2606:2800:220:1::1"),
    });
    expect(res).toEqual({ blocked: false, pinnedAddress: "2606:2800:220:1::1" });
  });

  it("fails closed when resolution returns no addresses", async () => {
    const res = await resolveAndCheckHost("nxdomain.example", { resolve: resolvesTo() });
    expect(res.blocked).toBe(true);
    if (res.blocked) expect(res.reason).toBe("resolution-failed");
  });

  it("fails closed when resolution throws, carrying the error detail", async () => {
    const res = await resolveAndCheckHost("flaky.example", { resolve: throws });
    expect(res).toEqual({
      blocked: true,
      reason: "resolution-failed",
      detail: "resolution failed",
    });
  });

  it("threads an injected isBlockedHostFn through both layers", async () => {
    // Permissive stub: loopback passes both the literal and resolved checks.
    const res = await resolveAndCheckHost("local.example", {
      resolve: resolvesTo("127.0.0.1"),
      isBlockedHostFn: () => false,
    });
    expect(res).toEqual({ blocked: false, pinnedAddress: "127.0.0.1" });
  });
});
