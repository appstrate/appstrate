// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  validateDomainList,
  isLoopbackHost,
} from "../../src/services/redirect-validation.ts";

describe("validateDomainList", () => {
  it("accepts valid domain list", () => {
    expect(validateDomainList(["example.com", "myapp.dev"])).toBeNull();
  });

  it("accepts empty list", () => {
    expect(validateDomainList([])).toBeNull();
  });

  it("rejects more than 20 domains", () => {
    const domains = Array.from({ length: 21 }, (_, i) => `domain${i}.com`);
    expect(validateDomainList(domains)).toContain("Maximum 20");
  });

  it("rejects invalid domain format", () => {
    expect(validateDomainList(["https://example.com"])).toContain("Invalid domain");
  });

  it("rejects domain with spaces", () => {
    expect(validateDomainList(["my app.com"])).toContain("Invalid domain");
  });

  it("accepts hyphenated domains", () => {
    expect(validateDomainList(["my-app.com"])).toBeNull();
  });

  it("accepts subdomains", () => {
    expect(validateDomainList(["staging.my-app.com"])).toBeNull();
  });

  it("rejects domain starting with hyphen", () => {
    expect(validateDomainList(["-invalid.com"])).toContain("Invalid domain");
  });
});

describe("isLoopbackHost", () => {
  it("accepts the literal name localhost (any case)", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("accepts the full IPv4 loopback range 127.0.0.0/8, not just 127.0.0.1", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.5")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("127.255.255.254")).toBe(true);
  });

  it("accepts the IPv6 loopback, with or without URL brackets", () => {
    // `new URL("http://[::1]/").hostname` returns "[::1]" (brackets kept).
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("rejects non-loopback hosts, including 127-prefixed domains and other IPs", () => {
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("127.example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("169.254.169.254")).toBe(false);
    expect(isLoopbackHost("[::]")).toBe(false);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
  });

  it("rejects malformed IPv4 octets", () => {
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
    expect(isLoopbackHost("127.0.0")).toBe(false);
  });
});
