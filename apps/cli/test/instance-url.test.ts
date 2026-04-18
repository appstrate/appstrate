// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/instance-url.ts` — HTTPS gate for CLI bearer-token
 * traffic. The module refuses `http://` against a non-loopback host
 * unless `APPSTRATE_INSECURE=1` is set; tests exercise both the allow
 * list and the opt-in bypass.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  normalizeInstance,
  stripTrailingSlash,
  isInsecureOptIn,
  InsecureInstanceError,
} from "../src/lib/instance-url.ts";

const originalEnv = process.env.APPSTRATE_INSECURE;

beforeEach(() => {
  delete process.env.APPSTRATE_INSECURE;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.APPSTRATE_INSECURE;
  else process.env.APPSTRATE_INSECURE = originalEnv;
});

describe("stripTrailingSlash", () => {
  it("removes a single trailing slash", () => {
    expect(stripTrailingSlash("https://a.com/")).toBe("https://a.com");
  });
  it("leaves an unslashed URL untouched", () => {
    expect(stripTrailingSlash("https://a.com")).toBe("https://a.com");
  });
});

describe("isInsecureOptIn", () => {
  it("is false when the env var is unset", () => {
    expect(isInsecureOptIn()).toBe(false);
  });
  it("accepts '1' and 'true'", () => {
    process.env.APPSTRATE_INSECURE = "1";
    expect(isInsecureOptIn()).toBe(true);
    process.env.APPSTRATE_INSECURE = "true";
    expect(isInsecureOptIn()).toBe(true);
  });
  it("rejects any other truthy value", () => {
    process.env.APPSTRATE_INSECURE = "yes";
    expect(isInsecureOptIn()).toBe(false);
  });
});

describe("normalizeInstance", () => {
  describe("always allowed", () => {
    it("accepts https for any host", () => {
      expect(normalizeInstance("https://appstrate.example.com")).toBe(
        "https://appstrate.example.com",
      );
    });
    it("accepts http://localhost", () => {
      expect(normalizeInstance("http://localhost:3000")).toBe("http://localhost:3000");
    });
    it("accepts http://127.0.0.1", () => {
      expect(normalizeInstance("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    });
    it("accepts http://[::1]", () => {
      expect(normalizeInstance("http://[::1]:3000")).toBe("http://[::1]:3000");
    });
    it("trims trailing whitespace + slash", () => {
      expect(normalizeInstance("  https://a.com/  ")).toBe("https://a.com");
    });
  });

  describe("refused by default", () => {
    it("throws InsecureInstanceError on http://non-loopback", () => {
      expect(() => normalizeInstance("http://appstrate.example.com")).toThrow(
        InsecureInstanceError,
      );
    });
    it("throws on http://10.0.0.5 (private LAN — still network)", () => {
      expect(() => normalizeInstance("http://10.0.0.5:3000")).toThrow(InsecureInstanceError);
    });
    it("throws on http://192.168.1.10", () => {
      expect(() => normalizeInstance("http://192.168.1.10")).toThrow(InsecureInstanceError);
    });
  });

  describe("with APPSTRATE_INSECURE=1", () => {
    beforeEach(() => {
      process.env.APPSTRATE_INSECURE = "1";
    });
    it("allows http://non-loopback", () => {
      expect(normalizeInstance("http://appstrate.example.com")).toBe(
        "http://appstrate.example.com",
      );
    });
    it("still refuses unsupported schemes", () => {
      expect(() => normalizeInstance("file:///etc/passwd")).toThrow();
      expect(() => normalizeInstance("ws://a.com")).toThrow();
    });
  });

  describe("validation", () => {
    it("throws on empty input", () => {
      expect(() => normalizeInstance("")).toThrow();
      expect(() => normalizeInstance("   ")).toThrow();
    });
    it("throws on malformed URLs", () => {
      expect(() => normalizeInstance("not a url")).toThrow();
      expect(() => normalizeInstance("://missing-scheme")).toThrow();
    });
    it("throws on non-http(s) schemes even via loopback", () => {
      expect(() => normalizeInstance("ftp://localhost")).toThrow();
    });
  });
});
