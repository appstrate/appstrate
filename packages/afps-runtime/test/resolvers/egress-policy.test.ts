// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for `compileEgressPolicy`: the runner egress allowlist compiled from
 * one connection's rendered `authorized_uris`, projected onto (host, port)
 * for TCP-level checks and applied as-is to full URLs.
 */

import { describe, it, expect } from "bun:test";
import { compileEgressPolicy } from "../../src/resolvers/index.ts";

const policy = (...authorizedUris: string[]) =>
  compileEgressPolicy({ authorizedUris, allowAllUris: false });

describe("compileEgressPolicy — allowsAuthority", () => {
  it("applies the scheme's default port to a port-less pattern", () => {
    const p = policy("https://api.github.com/**");
    expect(p.allowsAuthority("api.github.com", 443)).toBe(true);
    expect(p.allowsAuthority("api.github.com", 80)).toBe(false);
    expect(p.allowsAuthority("evil.com", 443)).toBe(false);
  });

  it("treats `https://h:443` and `https://h` identically", () => {
    for (const pattern of ["https://h.example.com:443/**", "https://h.example.com/**"]) {
      const p = policy(pattern);
      expect(p.allowsAuthority("h.example.com", 443)).toBe(true);
      expect(p.allowsAuthority("h.example.com", 8443)).toBe(false);
    }
  });

  it("uses the default table for http/ws/wss/sftp", () => {
    expect(policy("http://h.com/**").allowsAuthority("h.com", 80)).toBe(true);
    expect(policy("ws://h.com").allowsAuthority("h.com", 80)).toBe(true);
    expect(policy("wss://h.com").allowsAuthority("h.com", 443)).toBe(true);
    expect(policy("sftp://h.com").allowsAuthority("h.com", 22)).toBe(true);
    expect(policy("sftp://h.com").allowsAuthority("h.com", 2222)).toBe(false);
  });

  it("requires an explicit port to equal the target port", () => {
    const p = policy("ssh://h.example.com:2222");
    expect(p.allowsAuthority("h.example.com", 2222)).toBe(true);
    expect(p.allowsAuthority("h.example.com", 22)).toBe(false);
  });

  it("matches a subdomain wildcard across dots", () => {
    const p = policy("https://*.x.com/**");
    expect(p.allowsAuthority("a.b.x.com", 443)).toBe(true);
    expect(p.allowsAuthority("a.x.com", 8443)).toBe(false);
    expect(p.allowsAuthority("x.com.evil.com", 443)).toBe(false);
  });

  it("compares hosts case-insensitively, including non-special schemes", () => {
    const p = policy("ssh://Host.Example.com:22");
    expect(p.allowsAuthority("host.example.com", 22)).toBe(true);
    expect(p.allowsAuthority("HOST.EXAMPLE.COM", 22)).toBe(true);
  });

  it("lets the bare `scheme://**` catch-all through any host and port", () => {
    const p = policy("ssh://**");
    expect(p.allowsAuthority("anything.example", 22)).toBe(true);
    expect(p.allowsAuthority("anything.example", 8443)).toBe(true);
  });

  it("grants nothing for scheme-less, unrendered or unknown-scheme-without-port patterns", () => {
    expect(policy("api.x.com/**").allowsAuthority("api.x.com", 443)).toBe(false);
    const templated = policy("ssh://{$credential.host}:22");
    expect(templated.allowsAuthority("{$credential.host}", 22)).toBe(false);
    expect(templated.allowsAuthority("h.com", 22)).toBe(false);
    expect(policy("foo://h.com").allowsAuthority("h.com", 1234)).toBe(false);
    expect(policy("foo://h.com:1234").allowsAuthority("h.com", 1234)).toBe(true);
  });

  it("refuses IPv6, smuggling characters and invalid ports", () => {
    const p = policy("https://*.x.com/**", "ssh://**");
    expect(p.allowsAuthority("::1", 22)).toBe(false);
    expect(p.allowsAuthority("[::1]", 22)).toBe(false);
    expect(p.allowsAuthority("evil.com#.x.com", 443)).toBe(false);
    expect(p.allowsAuthority("evil.com@a.x.com", 443)).toBe(false);
    for (const port of [0, -1, 65536, Number.NaN, 22.5]) {
      expect(p.allowsAuthority("a.x.com", port)).toBe(false);
    }
  });

  it("denies everything for an empty list", () => {
    expect(policy().allowsAuthority("api.github.com", 443)).toBe(false);
  });
});

describe("compileEgressPolicy — allowsUrl", () => {
  it("is path-aware, like matchesAuthorizedUriSpec", () => {
    const p = policy("https://api.x.com/v1/**");
    expect(p.allowsUrl("https://api.x.com/v1/a")).toBe(true);
    expect(p.allowsUrl("https://api.x.com/v2/a")).toBe(false);
    expect(p.allowsUrl("https://evil.com?.api.x.com/v1/a")).toBe(false);
    expect(p.allowsUrl("not a url")).toBe(false);
  });

  it("matches when any pattern matches", () => {
    const p = policy("https://a.com/x", "https://b.com/**");
    expect(p.allowsUrl("https://a.com/x")).toBe(true);
    expect(p.allowsUrl("https://b.com/y/z")).toBe(true);
    expect(p.allowsUrl("https://a.com/y")).toBe(false);
  });

  it("denies everything for an empty list", () => {
    expect(policy().allowsUrl("https://api.github.com/")).toBe(false);
  });
});

describe("compileEgressPolicy — allowAllUris", () => {
  it("allows every authority and URL", () => {
    const p = compileEgressPolicy({ authorizedUris: [], allowAllUris: true });
    expect(p.allowsAuthority("anything.example", 8443)).toBe(true);
    expect(p.allowsUrl("https://anything.example/x")).toBe(true);
  });
});
