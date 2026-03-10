import { describe, expect, test } from "bun:test";
import {
  isBlockedHost,
  isBlockedUrl,
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUri,
  PROVIDER_ID_RE,
  MAX_RESPONSE_SIZE,
  OUTBOUND_TIMEOUT_MS,
} from "../helpers.ts";

// --- Constants ---

describe("constants", () => {
  test("MAX_RESPONSE_SIZE is 50_000", () => {
    expect(MAX_RESPONSE_SIZE).toBe(50_000);
  });

  test("OUTBOUND_TIMEOUT_MS is 30_000", () => {
    expect(OUTBOUND_TIMEOUT_MS).toBe(30_000);
  });

  test("PROVIDER_ID_RE accepts simple IDs", () => {
    expect(PROVIDER_ID_RE.test("gmail")).toBe(true);
    expect(PROVIDER_ID_RE.test("click-up")).toBe(true);
    expect(PROVIDER_ID_RE.test("a")).toBe(true);
  });

  test("PROVIDER_ID_RE accepts scoped IDs", () => {
    expect(PROVIDER_ID_RE.test("@appstrate/gmail")).toBe(true);
    expect(PROVIDER_ID_RE.test("@my-org/provider")).toBe(true);
  });

  test("PROVIDER_ID_RE rejects invalid IDs", () => {
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
  test("blocks localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
  });

  test("blocks sidecar", () => {
    expect(isBlockedHost("sidecar")).toBe(true);
  });

  test("blocks agent", () => {
    expect(isBlockedHost("agent")).toBe(true);
  });

  test("blocks host.docker.internal", () => {
    expect(isBlockedHost("host.docker.internal")).toBe(true);
  });

  test("blocks metadata.google.internal", () => {
    expect(isBlockedHost("metadata.google.internal")).toBe(true);
  });

  // IPv4 loopback range
  test("blocks 127.0.0.1", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
  });

  test("blocks 127.255.255.255 (full /8)", () => {
    expect(isBlockedHost("127.255.255.255")).toBe(true);
  });

  // IPv4 private ranges
  test("blocks 10.x.x.x", () => {
    expect(isBlockedHost("10.0.0.1")).toBe(true);
    expect(isBlockedHost("10.255.255.255")).toBe(true);
  });

  test("blocks 172.16-31.x.x", () => {
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
  });

  test("blocks 192.168.x.x", () => {
    expect(isBlockedHost("192.168.0.1")).toBe(true);
    expect(isBlockedHost("192.168.255.255")).toBe(true);
  });

  test("blocks 169.254.x.x (link-local)", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  test("blocks 0.0.0.0", () => {
    expect(isBlockedHost("0.0.0.0")).toBe(true);
  });

  // Allowed public IPv4
  test("allows 8.8.8.8", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
  });

  test("allows 172.15.0.1 (below 172.16 range)", () => {
    expect(isBlockedHost("172.15.0.1")).toBe(false);
  });

  test("allows 172.32.0.1 (above 172.31 range)", () => {
    expect(isBlockedHost("172.32.0.1")).toBe(false);
  });

  test("allows public hostname", () => {
    expect(isBlockedHost("api.example.com")).toBe(false);
  });

  // Numeric bypass attempts
  test("blocks numeric 2130706433 (=127.0.0.1)", () => {
    expect(isBlockedHost("2130706433")).toBe(true);
  });

  test("blocks hex 0x7f000001 (=127.0.0.1)", () => {
    expect(isBlockedHost("0x7f000001")).toBe(true);
  });

  // IPv6
  test("blocks ::1 (loopback)", () => {
    expect(isBlockedHost("::1")).toBe(true);
  });

  test("blocks :: (unspecified)", () => {
    expect(isBlockedHost("::")).toBe(true);
  });

  test("blocks fe80::1 (link-local)", () => {
    expect(isBlockedHost("fe80::1")).toBe(true);
  });

  test("blocks fc00::1 (unique local)", () => {
    expect(isBlockedHost("fc00::1")).toBe(true);
  });

  test("blocks fd00::1 (unique local)", () => {
    expect(isBlockedHost("fd00::1")).toBe(true);
  });

  // IPv4-mapped IPv6
  test("blocks ::ffff:7f00:1 (=127.0.0.1 mapped)", () => {
    expect(isBlockedHost("::ffff:7f00:1")).toBe(true);
  });

  test("blocks ::ffff:a9fe:a9fe (=169.254.169.254 mapped)", () => {
    expect(isBlockedHost("::ffff:a9fe:a9fe")).toBe(true);
  });

  test("allows ::ffff:0808:0808 (=8.8.8.8 mapped)", () => {
    expect(isBlockedHost("::ffff:0808:0808")).toBe(false);
  });

  // Edge cases
  test("blocks unparseable hostname", () => {
    expect(isBlockedHost("")).toBe(true);
  });

  test("allows bracketed public IPv6", () => {
    expect(isBlockedHost("[2001:db8::1]")).toBe(false);
  });
});

// --- isBlockedUrl ---

describe("isBlockedUrl", () => {
  test("blocks ftp: scheme", () => {
    expect(isBlockedUrl("ftp://example.com/file")).toBe(true);
  });

  test("blocks file: scheme", () => {
    expect(isBlockedUrl("file:///etc/passwd")).toBe(true);
  });

  test("blocks URL to internal host", () => {
    expect(isBlockedUrl("http://127.0.0.1/admin")).toBe(true);
  });

  test("allows public https URL", () => {
    expect(isBlockedUrl("https://api.example.com/v1")).toBe(false);
  });

  test("allows public http URL", () => {
    expect(isBlockedUrl("http://api.example.com/v1")).toBe(false);
  });

  test("blocks malformed URL", () => {
    expect(isBlockedUrl("not-a-url")).toBe(true);
  });
});

// --- substituteVars ---

describe("substituteVars", () => {
  test("replaces single variable", () => {
    expect(substituteVars("Bearer {{token}}", { token: "abc" })).toBe("Bearer abc");
  });

  test("replaces multiple variables", () => {
    expect(substituteVars("{{host}}/{{path}}", { host: "example.com", path: "api" })).toBe(
      "example.com/api",
    );
  });

  test("leaves unknown placeholders unchanged", () => {
    expect(substituteVars("{{missing}}", {})).toBe("{{missing}}");
  });

  test("handles text without variables", () => {
    expect(substituteVars("plain text", { key: "val" })).toBe("plain text");
  });

  test("handles empty string", () => {
    expect(substituteVars("", { key: "val" })).toBe("");
  });
});

// --- findUnresolvedPlaceholders ---

describe("findUnresolvedPlaceholders", () => {
  test("finds unresolved placeholders", () => {
    expect(findUnresolvedPlaceholders("{{foo}} and {{bar}}")).toEqual(["foo", "bar"]);
  });

  test("returns empty array when none", () => {
    expect(findUnresolvedPlaceholders("no placeholders here")).toEqual([]);
  });

  test("finds single placeholder", () => {
    expect(findUnresolvedPlaceholders("value is {{key}}")).toEqual(["key"]);
  });

  test("handles empty string", () => {
    expect(findUnresolvedPlaceholders("")).toEqual([]);
  });
});

// --- matchesAuthorizedUri ---

describe("matchesAuthorizedUri", () => {
  test("matches exact URL", () => {
    expect(matchesAuthorizedUri("https://api.example.com/v1", ["https://api.example.com/v1"])).toBe(
      true,
    );
  });

  test("matches wildcard pattern", () => {
    expect(
      matchesAuthorizedUri("https://api.example.com/v1/users", ["https://api.example.com/*"]),
    ).toBe(true);
  });

  test("rejects non-matching URL", () => {
    expect(
      matchesAuthorizedUri("https://evil.com/api", ["https://api.example.com/*"]),
    ).toBe(false);
  });

  test("rejects when patterns is empty", () => {
    expect(matchesAuthorizedUri("https://api.example.com/v1", [])).toBe(false);
  });

  test("matches with multiple patterns", () => {
    expect(
      matchesAuthorizedUri("https://b.com/data", ["https://a.com/*", "https://b.com/*"]),
    ).toBe(true);
  });
});
