// SPDX-License-Identifier: Apache-2.0

/**
 * DNS-resolving SSRF guard (`isBlockedUrlWithDns`). Pure logic — the resolver
 * is injected so the rebind-to-internal branch is exercised deterministically
 * without real DNS.
 */

import { describe, it, expect } from "bun:test";
import { isBlockedUrlWithDns, type HostResolver } from "../../src/lib/ssrf-dns.ts";

const resolvesTo =
  (...addrs: string[]): HostResolver =>
  async () =>
    addrs;
const throws: HostResolver = async () => {
  throw new Error("resolution failed");
};

describe("isBlockedUrlWithDns", () => {
  it("blocks a literal-internal URL without consulting DNS", async () => {
    let called = false;
    const spy: HostResolver = async (h) => {
      called = true;
      return [h];
    };
    expect(
      await isBlockedUrlWithDns("http://169.254.169.254/latest/meta-data", { resolve: spy }),
    ).toBe(true);
    expect(called).toBe(false); // short-circuited by the literal denylist
  });

  it("blocks a non-http(s) scheme", async () => {
    expect(
      await isBlockedUrlWithDns("file:///etc/passwd", { resolve: resolvesTo("1.2.3.4") }),
    ).toBe(true);
  });

  it("blocks a malformed URL", async () => {
    expect(await isBlockedUrlWithDns("http://[bad", { resolve: resolvesTo("1.2.3.4") })).toBe(true);
  });

  it("blocks a public hostname that RESOLVES to a private address (rebind)", async () => {
    // The core of the fix: literal check passes (evil.example is not internal),
    // but its A record points inside — must be blocked.
    expect(
      await isBlockedUrlWithDns("https://evil.example/doc", {
        resolve: resolvesTo("169.254.169.254"),
      }),
    ).toBe(true);
  });

  it("blocks when ANY resolved address is private (mixed records)", async () => {
    expect(
      await isBlockedUrlWithDns("https://evil.example/doc", {
        resolve: resolvesTo("93.184.216.34", "10.0.0.5"),
      }),
    ).toBe(true);
  });

  it("blocks an IPv4-mapped-IPv6 resolution to loopback", async () => {
    expect(
      await isBlockedUrlWithDns("https://evil.example/doc", {
        resolve: resolvesTo("::ffff:127.0.0.1"),
      }),
    ).toBe(true);
  });

  it("allows a public hostname resolving only to public addresses", async () => {
    expect(
      await isBlockedUrlWithDns("https://client.example/cimd.json", {
        resolve: resolvesTo("93.184.216.34"),
      }),
    ).toBe(false);
  });

  it("blocks (fails closed) when resolution returns no addresses", async () => {
    expect(
      await isBlockedUrlWithDns("https://nxdomain.example/doc", { resolve: resolvesTo() }),
    ).toBe(true);
  });

  it("blocks (fails closed) when resolution throws", async () => {
    expect(await isBlockedUrlWithDns("https://flaky.example/doc", { resolve: throws })).toBe(true);
  });
});
