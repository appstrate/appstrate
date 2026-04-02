// SPDX-License-Identifier: Apache-2.0

import { describe, test, expect } from "bun:test";
import { isBlockedHost, isBlockedUrl } from "../src/ssrf.ts";

describe("isBlockedHost", () => {
  test("blocks localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
  });

  test("blocks Docker internal hostnames", () => {
    expect(isBlockedHost("sidecar")).toBe(true);
    expect(isBlockedHost("agent")).toBe(true);
    expect(isBlockedHost("host.docker.internal")).toBe(true);
  });

  test("blocks cloud metadata service", () => {
    expect(isBlockedHost("metadata.google.internal")).toBe(true);
  });

  test("blocks IPv4 loopback range", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("127.255.255.255")).toBe(true);
  });

  test("blocks private IPv4 ranges", () => {
    expect(isBlockedHost("10.0.0.1")).toBe(true);
    expect(isBlockedHost("10.255.255.255")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
    expect(isBlockedHost("192.168.0.1")).toBe(true);
    expect(isBlockedHost("192.168.255.255")).toBe(true);
  });

  test("blocks link-local", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  test("blocks 0.0.0.0/8", () => {
    expect(isBlockedHost("0.0.0.0")).toBe(true);
  });

  test("allows public IPs", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("172.15.0.1")).toBe(false);
    expect(isBlockedHost("172.32.0.1")).toBe(false);
  });

  test("allows public hostnames", () => {
    expect(isBlockedHost("api.example.com")).toBe(false);
  });

  test("blocks numeric IP bypass", () => {
    expect(isBlockedHost("2130706433")).toBe(true); // 127.0.0.1 as decimal
  });

  test("blocks hex IP bypass", () => {
    expect(isBlockedHost("0x7f000001")).toBe(true); // 127.0.0.1 as hex
  });

  test("blocks IPv6 loopback", () => {
    expect(isBlockedHost("::1")).toBe(true);
    expect(isBlockedHost("::")).toBe(true);
  });

  test("blocks IPv6 link-local", () => {
    expect(isBlockedHost("fe80::1")).toBe(true);
  });

  test("blocks IPv6 unique local", () => {
    expect(isBlockedHost("fc00::1")).toBe(true);
    expect(isBlockedHost("fd00::1")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6", () => {
    expect(isBlockedHost("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isBlockedHost("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isBlockedHost("::ffff:0808:0808")).toBe(false); // 8.8.8.8
  });

  test("blocks unparseable hostname", () => {
    expect(isBlockedHost("")).toBe(true);
  });

  test("handles bracketed IPv6", () => {
    expect(isBlockedHost("[2001:db8::1]")).toBe(false);
  });
});

describe("isBlockedUrl", () => {
  test("blocks non-http schemes", () => {
    expect(isBlockedUrl("ftp://example.com/file")).toBe(true);
    expect(isBlockedUrl("file:///etc/passwd")).toBe(true);
  });

  test("blocks private IPs", () => {
    expect(isBlockedUrl("http://127.0.0.1/admin")).toBe(true);
  });

  test("allows public HTTPS", () => {
    expect(isBlockedUrl("https://api.example.com/v1")).toBe(false);
  });

  test("allows public HTTP", () => {
    expect(isBlockedUrl("http://api.example.com/v1")).toBe(false);
  });

  test("blocks malformed URLs", () => {
    expect(isBlockedUrl("not-a-url")).toBe(true);
  });
});
