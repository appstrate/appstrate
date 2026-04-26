// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  ABSOLUTE_BODY_CEILING,
  isBlockedHost,
  isBlockedUrl,
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUri,
  MAX_MCP_ENVELOPE_SIZE,
  MAX_REQUEST_BODY_SIZE,
  PROVIDER_ID_RE,
  MAX_RESPONSE_SIZE,
  ABSOLUTE_MAX_RESPONSE_SIZE,
  OUTBOUND_TIMEOUT_MS,
  readPositiveByteEnv,
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

  it("MAX_REQUEST_BODY_SIZE defaults to 10 MB", () => {
    expect(MAX_REQUEST_BODY_SIZE).toBe(10 * 1024 * 1024);
  });

  it("MAX_MCP_ENVELOPE_SIZE defaults to 16 MB", () => {
    expect(MAX_MCP_ENVELOPE_SIZE).toBe(16 * 1024 * 1024);
  });

  it("ABSOLUTE_BODY_CEILING is 100 MB", () => {
    expect(ABSOLUTE_BODY_CEILING).toBe(100 * 1024 * 1024);
  });

  it("MAX_MCP_ENVELOPE_SIZE leaves room for base64-encoded MAX_REQUEST_BODY_SIZE", () => {
    // base64 inflates ~1.37×; envelope must fit the inflated body plus
    // JSON-RPC overhead (negligible for any realistic call shape).
    const minEnvelopeNeeded = Math.ceil((MAX_REQUEST_BODY_SIZE * 4) / 3);
    expect(MAX_MCP_ENVELOPE_SIZE).toBeGreaterThanOrEqual(minEnvelopeNeeded);
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

describe("readPositiveByteEnv", () => {
  // Use a unique env var name per test to avoid leakage between cases.
  // bun:test runs sequentially within a file so reuse-with-cleanup is
  // also safe, but unique names keep failures attributable.
  const NAME_BASE = "__APPSTRATE_TEST_BYTE_ENV";

  it("returns the default when the env var is unset", () => {
    const name = `${NAME_BASE}_UNSET`;
    delete process.env[name];
    expect(readPositiveByteEnv(name, 1234)).toBe(1234);
  });

  it("returns the default when the env var is empty", () => {
    const name = `${NAME_BASE}_EMPTY`;
    process.env[name] = "";
    try {
      expect(readPositiveByteEnv(name, 1234)).toBe(1234);
    } finally {
      delete process.env[name];
    }
  });

  it("returns the parsed value when the env var is a valid positive integer", () => {
    const name = `${NAME_BASE}_VALID`;
    process.env[name] = "5242880"; // 5 MB
    try {
      expect(readPositiveByteEnv(name, 1234)).toBe(5_242_880);
    } finally {
      delete process.env[name];
    }
  });

  it("throws when the env var is non-numeric", () => {
    const name = `${NAME_BASE}_NON_NUMERIC`;
    process.env[name] = "ten megabytes";
    try {
      expect(() => readPositiveByteEnv(name, 1234)).toThrow(/positive integer/);
    } finally {
      delete process.env[name];
    }
  });

  it("throws when the env var is zero or negative", () => {
    const name = `${NAME_BASE}_NEGATIVE`;
    process.env[name] = "-1";
    try {
      expect(() => readPositiveByteEnv(name, 1234)).toThrow(/positive integer/);
    } finally {
      delete process.env[name];
    }

    const zeroName = `${NAME_BASE}_ZERO`;
    process.env[zeroName] = "0";
    try {
      expect(() => readPositiveByteEnv(zeroName, 1234)).toThrow(/positive integer/);
    } finally {
      delete process.env[zeroName];
    }
  });

  it("throws when the env var is non-integer", () => {
    const name = `${NAME_BASE}_FLOAT`;
    process.env[name] = "1.5";
    try {
      expect(() => readPositiveByteEnv(name, 1234)).toThrow(/positive integer/);
    } finally {
      delete process.env[name];
    }
  });

  it("throws when the env var exceeds the absolute ceiling", () => {
    const name = `${NAME_BASE}_OVER_CEILING`;
    // Default ceiling is 100 MB; ask for 200 MB.
    process.env[name] = String(200 * 1024 * 1024);
    try {
      expect(() => readPositiveByteEnv(name, 1234)).toThrow(/absolute ceiling/);
    } finally {
      delete process.env[name];
    }
  });

  it("respects a custom ceiling argument", () => {
    const name = `${NAME_BASE}_CUSTOM_CEILING`;
    process.env[name] = "1000";
    try {
      // Within the custom ceiling — accepted.
      expect(readPositiveByteEnv(name, 100, 5000)).toBe(1000);
    } finally {
      delete process.env[name];
    }

    process.env[name] = "10000";
    try {
      // Above the custom ceiling — rejected even though far below the
      // module-level ABSOLUTE_BODY_CEILING.
      expect(() => readPositiveByteEnv(name, 100, 5000)).toThrow(/absolute ceiling/);
    } finally {
      delete process.env[name];
    }
  });
});
