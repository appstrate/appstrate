// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  isBlockedHost,
  isBlockedUrl,
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUri,
  PROVIDER_ID_RE,
  MAX_RESPONSE_SIZE,
  ABSOLUTE_MAX_RESPONSE_SIZE,
  OUTBOUND_TIMEOUT_MS,
} from "../helpers.ts";

// --- Constants ---

describe("constants", () => {
  it("MAX_RESPONSE_SIZE is 256 KB", () => {
    expect(MAX_RESPONSE_SIZE).toBe(256 * 1024);
  });

  it("ABSOLUTE_MAX_RESPONSE_SIZE is 1_000_000", () => {
    expect(ABSOLUTE_MAX_RESPONSE_SIZE).toBe(1_000_000);
  });

  it("OUTBOUND_TIMEOUT_MS is 30_000", () => {
    expect(OUTBOUND_TIMEOUT_MS).toBe(30_000);
  });

  it("PROVIDER_ID_RE accepts simple IDs", () => {
    expect(PROVIDER_ID_RE.test("gmail")).toBe(true);
    expect(PROVIDER_ID_RE.test("click-up")).toBe(true);
    expect(PROVIDER_ID_RE.test("a")).toBe(true);
  });

  it("PROVIDER_ID_RE accepts scoped IDs", () => {
    expect(PROVIDER_ID_RE.test("@appstrate/gmail")).toBe(true);
    expect(PROVIDER_ID_RE.test("@my-org/provider")).toBe(true);
  });

  it("PROVIDER_ID_RE rejects invalid IDs", () => {
    expect(PROVIDER_ID_RE.test("")).toBe(false);
    expect(PROVIDER_ID_RE.test("UPPER")).toBe(false);
    expect(PROVIDER_ID_RE.test("../etc/passwd")).toBe(false);
    expect(PROVIDER_ID_RE.test("has spaces")).toBe(false);
    expect(PROVIDER_ID_RE.test("-starts-with-dash")).toBe(false);
  });
});

// --- isBlockedHost ---

describe("isBlockedHost", () => {
  // Docker hostnames
  it("blocks localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
  });

  it("blocks sidecar", () => {
    expect(isBlockedHost("sidecar")).toBe(true);
  });

  it("blocks agent", () => {
    expect(isBlockedHost("agent")).toBe(true);
  });

  it("blocks host.docker.internal", () => {
    expect(isBlockedHost("host.docker.internal")).toBe(true);
  });

  it("blocks metadata.google.internal", () => {
    expect(isBlockedHost("metadata.google.internal")).toBe(true);
  });

  // IPv4 loopback range
  it("blocks 127.0.0.1", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
  });

  it("blocks 127.255.255.255 (full /8)", () => {
    expect(isBlockedHost("127.255.255.255")).toBe(true);
  });

  // IPv4 private ranges
  it("blocks 10.x.x.x", () => {
    expect(isBlockedHost("10.0.0.1")).toBe(true);
    expect(isBlockedHost("10.255.255.255")).toBe(true);
  });

  it("blocks 172.16-31.x.x", () => {
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
  });

  it("blocks 192.168.x.x", () => {
    expect(isBlockedHost("192.168.0.1")).toBe(true);
    expect(isBlockedHost("192.168.255.255")).toBe(true);
  });

  it("blocks 169.254.x.x (link-local)", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  it("blocks 0.0.0.0", () => {
    expect(isBlockedHost("0.0.0.0")).toBe(true);
  });

  // Allowed public IPv4
  it("allows 8.8.8.8", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
  });

  it("allows 172.15.0.1 (below 172.16 range)", () => {
    expect(isBlockedHost("172.15.0.1")).toBe(false);
  });

  it("allows 172.32.0.1 (above 172.31 range)", () => {
    expect(isBlockedHost("172.32.0.1")).toBe(false);
  });

  it("allows public hostname", () => {
    expect(isBlockedHost("api.example.com")).toBe(false);
  });

  // Numeric bypass attempts
  it("blocks numeric 2130706433 (=127.0.0.1)", () => {
    expect(isBlockedHost("2130706433")).toBe(true);
  });

  it("blocks hex 0x7f000001 (=127.0.0.1)", () => {
    expect(isBlockedHost("0x7f000001")).toBe(true);
  });

  // IPv6
  it("blocks ::1 (loopback)", () => {
    expect(isBlockedHost("::1")).toBe(true);
  });

  it("blocks :: (unspecified)", () => {
    expect(isBlockedHost("::")).toBe(true);
  });

  it("blocks fe80::1 (link-local)", () => {
    expect(isBlockedHost("fe80::1")).toBe(true);
  });

  it("blocks fc00::1 (unique local)", () => {
    expect(isBlockedHost("fc00::1")).toBe(true);
  });

  it("blocks fd00::1 (unique local)", () => {
    expect(isBlockedHost("fd00::1")).toBe(true);
  });

  // IPv4-mapped IPv6
  it("blocks ::ffff:7f00:1 (=127.0.0.1 mapped)", () => {
    expect(isBlockedHost("::ffff:7f00:1")).toBe(true);
  });

  it("blocks ::ffff:a9fe:a9fe (=169.254.169.254 mapped)", () => {
    expect(isBlockedHost("::ffff:a9fe:a9fe")).toBe(true);
  });

  it("allows ::ffff:0808:0808 (=8.8.8.8 mapped)", () => {
    expect(isBlockedHost("::ffff:0808:0808")).toBe(false);
  });

  // Edge cases
  it("blocks unparseable hostname", () => {
    expect(isBlockedHost("")).toBe(true);
  });

  it("allows bracketed public IPv6", () => {
    expect(isBlockedHost("[2001:db8::1]")).toBe(false);
  });
});

// --- isBlockedUrl ---

describe("isBlockedUrl", () => {
  it("blocks ftp: scheme", () => {
    expect(isBlockedUrl("ftp://example.com/file")).toBe(true);
  });

  it("blocks file: scheme", () => {
    expect(isBlockedUrl("file:///etc/passwd")).toBe(true);
  });

  it("blocks URL to internal host", () => {
    expect(isBlockedUrl("http://127.0.0.1/admin")).toBe(true);
  });

  it("allows public https URL", () => {
    expect(isBlockedUrl("https://api.example.com/v1")).toBe(false);
  });

  it("allows public http URL", () => {
    expect(isBlockedUrl("http://api.example.com/v1")).toBe(false);
  });

  it("blocks malformed URL", () => {
    expect(isBlockedUrl("not-a-url")).toBe(true);
  });
});

// --- substituteVars ---

describe("substituteVars", () => {
  it("replaces single variable", () => {
    expect(substituteVars("Bearer {{token}}", { token: "abc" })).toBe("Bearer abc");
  });

  it("replaces multiple variables", () => {
    expect(substituteVars("{{host}}/{{path}}", { host: "example.com", path: "api" })).toBe(
      "example.com/api",
    );
  });

  it("leaves unknown placeholders unchanged", () => {
    expect(substituteVars("{{missing}}", {})).toBe("{{missing}}");
  });

  it("handles text without variables", () => {
    expect(substituteVars("plain text", { key: "val" })).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(substituteVars("", { key: "val" })).toBe("");
  });
});

// --- findUnresolvedPlaceholders ---

describe("findUnresolvedPlaceholders", () => {
  it("finds unresolved placeholders", () => {
    expect(findUnresolvedPlaceholders("{{foo}} and {{bar}}")).toEqual(["foo", "bar"]);
  });

  it("returns empty array when none", () => {
    expect(findUnresolvedPlaceholders("no placeholders here")).toEqual([]);
  });

  it("finds single placeholder", () => {
    expect(findUnresolvedPlaceholders("value is {{key}}")).toEqual(["key"]);
  });

  it("handles empty string", () => {
    expect(findUnresolvedPlaceholders("")).toEqual([]);
  });
});

// --- matchesAuthorizedUri ---

describe("matchesAuthorizedUri", () => {
  it("matches exact URL", () => {
    expect(matchesAuthorizedUri("https://api.example.com/v1", ["https://api.example.com/v1"])).toBe(
      true,
    );
  });

  it("`**` matches any substring including path separators", () => {
    expect(
      matchesAuthorizedUri("https://api.example.com/v1/users", ["https://api.example.com/**"]),
    ).toBe(true);
  });

  it("`*` matches a single path segment only", () => {
    expect(
      matchesAuthorizedUri("https://api.example.com/v1/users", ["https://api.example.com/*"]),
    ).toBe(false);
    expect(
      matchesAuthorizedUri("https://api.example.com/users", ["https://api.example.com/*"]),
    ).toBe(true);
  });

  it("rejects non-matching URL", () => {
    expect(matchesAuthorizedUri("https://evil.com/api", ["https://api.example.com/**"])).toBe(
      false,
    );
  });

  it("rejects when patterns is empty", () => {
    expect(matchesAuthorizedUri("https://api.example.com/v1", [])).toBe(false);
  });

  it("matches with multiple patterns", () => {
    expect(
      matchesAuthorizedUri("https://b.com/data", ["https://a.com/**", "https://b.com/**"]),
    ).toBe(true);
  });
});
