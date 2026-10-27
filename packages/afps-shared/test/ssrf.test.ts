// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isBlockedHost, isLoopbackHost, parseEgressAllowInternalHosts } from "../src/ssrf.ts";

describe("isLoopbackHost", () => {
  it("recognises this machine in every form the URL parser normalises", () => {
    const loopback = [
      "localhost",
      "foo.localhost",
      "127.1",
      "0.0.0.0",
      "[::1]",
      "[::]",
      "[::ffff:127.0.0.1]",
    ];
    expect(loopback.filter((h) => !isLoopbackHost(h))).toEqual([]);
  });

  it("leaves internal and public hosts alone, though the first stay blocked", () => {
    const elsewhere = ["10.0.0.5", "169.254.169.254", "example.com"];
    expect(elsewhere.map(isLoopbackHost)).toEqual([false, false, false]);
    expect(elsewhere.map(isBlockedHost)).toEqual([true, true, false]);
  });

  it("counts an unparseable host as loopback (fail closed)", () => {
    expect(["", "bad host", "%zz"].map(isLoopbackHost)).toEqual([true, true, true]);
  });
});

describe("parseEgressAllowInternalHosts", () => {
  const parsed = (raw: string | undefined) => {
    const { hosts, invalid } = parseEgressAllowInternalHosts(raw);
    return { hosts: [...hosts], invalid };
  };
  const refusal = (entry: string) =>
    `"${entry}" is not a bare hostname or dotted IPv4 address (e.g. "keycloak.internal", "10.0.0.5"; no scheme, port, path, wildcard, IPv6 literal or trailing dot; IDN hosts in punycode)`;

  it("reads undefined and whitespace-only input as an empty allowlist", () => {
    expect(parsed(undefined)).toEqual({ hosts: [], invalid: [] });
    expect(parsed("   ")).toEqual({ hosts: [], invalid: [] });
  });

  it("trims and lowercases a bare hostname", () => {
    expect(parsed("keycloak.internal")).toEqual({ hosts: ["keycloak.internal"], invalid: [] });
    expect(parsed(" KeyCloak.Internal ")).toEqual({ hosts: ["keycloak.internal"], invalid: [] });
  });

  it("keeps single-label names, dotted IPv4 and punycode hosts", () => {
    expect(parsed("llm_svc,localhost,10.0.0.5,xn--bcher-kva.example")).toEqual({
      hosts: ["llm_svc", "localhost", "10.0.0.5", "xn--bcher-kva.example"],
      invalid: [],
    });
  });

  it("skips empty items, so a doubled or trailing comma names nothing", () => {
    expect(parsed("a,,b,")).toEqual({ hosts: ["a", "b"], invalid: [] });
  });

  it("refuses every entry that is not a bare hostname or dotted IPv4, naming it", () => {
    const refused = [
      "keycloak.internal:8443",
      "::1",
      "[::1]",
      "fd00::1",
      "https://kc.internal",
      "kc.internal/",
      "*.internal",
      "u@h",
      "key cloak",
      "kc.internal.",
      "bücher.example",
      "127.1",
      "0x7f.0.0.1",
      "999.1.1.1",
      "a?b",
    ];
    for (const entry of refused) {
      expect(parsed(entry)).toEqual({ hosts: [], invalid: [refusal(entry)] });
    }
  });

  it("keeps the valid entries of a mixed list and reports every refused one in input order", () => {
    expect(parsed("keycloak.internal, https://kc.internal, a?b, llm_svc,")).toEqual({
      hosts: ["keycloak.internal", "llm_svc"],
      invalid: [refusal("https://kc.internal"), refusal("a?b")],
    });
  });

  describe("matching a URL against the parsed set", () => {
    const { hosts } = parseEgressAllowInternalHosts("keycloak.internal,10.0.0.5");
    const exempt = (target: string) => hosts.has(new URL(target).hostname.toLowerCase());

    it("exempts a case-differing host, ignoring the port", () => {
      expect(exempt("https://KEYCLOAK.internal:8443/x")).toBe(true);
    });

    it("does not exempt a host with a trailing dot, which keeps the dot in URL.hostname", () => {
      expect(exempt("https://keycloak.internal./")).toBe(false);
    });

    it("does not exempt a subdomain, since matching is exact", () => {
      expect(exempt("https://sub.keycloak.internal/")).toBe(false);
    });

    it("exempts a numeric IPv4 form that the URL parser normalizes", () => {
      expect(exempt("http://0x0a.0.0.5/")).toBe(true);
    });

    it("does not exempt an IPv4-mapped IPv6 literal, whose hostname keeps brackets", () => {
      expect(exempt("http://[::ffff:10.0.0.5]/")).toBe(false);
    });
  });
});
