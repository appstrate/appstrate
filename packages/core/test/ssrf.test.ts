// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isBlockedHost, isBlockedUrl } from "../src/ssrf.ts";

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

  it("allows public IPs", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("172.15.0.1")).toBe(false);
    expect(isBlockedHost("172.32.0.1")).toBe(false);
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
