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

  it("refuses an entry carrying a port", () => {
    expect(parsed("keycloak.internal:8443").invalid).toEqual([
      '"keycloak.internal:8443" contains ":" — a port is not part of an entry, and IPv6 literals are not supported (give the host a DNS name)',
    ]);
  });

  it("refuses IPv6 literals, bracketed or not", () => {
    const reason = (e: string) =>
      `"${e}" contains ":" — a port is not part of an entry, and IPv6 literals are not supported (give the host a DNS name)`;
    expect(parsed("::1").invalid).toEqual([reason("::1")]);
    expect(parsed("[::1]").invalid).toEqual([reason("[::1]")]);
    expect(parsed("fd00::1").invalid).toEqual([reason("fd00::1")]);
  });

  it("refuses a URL", () => {
    expect(parsed("https://kc.internal").invalid).toEqual([
      '"https://kc.internal" is a URL — list the bare hostname',
    ]);
  });

  it("refuses a path", () => {
    expect(parsed("kc.internal/").invalid).toEqual([
      '"kc.internal/" contains "/" — list the bare hostname, without a path',
    ]);
  });

  it("refuses a wildcard", () => {
    expect(parsed("*.internal").invalid).toEqual([
      '"*.internal" contains "*" — wildcards are not supported; list each host',
    ]);
  });

  it("refuses userinfo", () => {
    expect(parsed("u@h").invalid).toEqual(['"u@h" contains "@" — list the bare hostname']);
  });

  it("refuses an entry with internal whitespace", () => {
    expect(parsed("key cloak").invalid).toEqual([
      '"key cloak" contains whitespace — separate entries with commas',
    ]);
  });

  it("refuses a trailing dot", () => {
    expect(parsed("kc.internal.").invalid).toEqual([
      '"kc.internal." ends with "." — drop the trailing dot',
    ]);
  });

  it("refuses a non-ASCII name and names its punycode form", () => {
    expect(parsed("bücher.example").invalid).toEqual([
      '"bücher.example" is not in canonical form — write it as "xn--bcher-kva.example"',
    ]);
  });

  it("refuses a shortened IPv4 and names its dotted form", () => {
    expect(parsed("127.1").invalid).toEqual([
      '"127.1" is not in canonical form — write it as "127.0.0.1"',
    ]);
  });

  it("refuses a hex IPv4 and names its dotted form", () => {
    expect(parsed("0x7f.0.0.1").invalid).toEqual([
      '"0x7f.0.0.1" is not in canonical form — write it as "127.0.0.1"',
    ]);
  });

  it("refuses an out-of-range IPv4", () => {
    expect(parsed("999.1.1.1").invalid).toEqual([
      '"999.1.1.1" is not a valid hostname or IPv4 address',
    ]);
  });

  it("refuses a character a hostname cannot hold, without suggesting a host", () => {
    expect(parsed("a?b").invalid).toEqual(['"a?b" contains characters a hostname cannot hold']);
  });

  it("keeps the valid entries of a mixed list and reports every refused one in input order", () => {
    expect(parsed("keycloak.internal, https://kc.internal, a?b, llm_svc,")).toEqual({
      hosts: ["keycloak.internal", "llm_svc"],
      invalid: [
        '"https://kc.internal" is a URL — list the bare hostname',
        '"a?b" contains characters a hostname cannot hold',
      ],
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
