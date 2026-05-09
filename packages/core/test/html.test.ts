// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { escapeHtml } from "../src/html.ts";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets (script-tag injection)", () => {
    expect(escapeHtml(`<script>alert("xss")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("escapes double quotes (attribute breakout)", () => {
    expect(escapeHtml(`" onerror="alert(1)`)).toBe("&quot; onerror=&quot;alert(1)");
  });

  it("escapes single quotes (single-quoted attribute breakout)", () => {
    expect(escapeHtml(`' onerror='alert(1)`)).toBe("&#39; onerror=&#39;alert(1)");
  });

  it("escapes all five special characters in one call", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes ampersand only once (no double encoding)", () => {
    expect(escapeHtml("a&amp;b")).toBe("a&amp;amp;b");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("returns plain ASCII unchanged", () => {
    expect(escapeHtml("Hello, world!")).toBe("Hello, world!");
  });

  it("preserves Unicode characters", () => {
    expect(escapeHtml("café — naïve — 日本語")).toBe("café — naïve — 日本語");
  });
});
