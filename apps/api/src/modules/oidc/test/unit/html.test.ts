// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { escapeHtml, html, raw } from "../../pages/html.ts";

describe("escapeHtml", () => {
  it("escapes the five HTML-unsafe characters", () => {
    expect(escapeHtml(`<script>alert("xss")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("escapes single quotes and ampersands", () => {
    expect(escapeHtml("a&b 'c'")).toBe("a&amp;b &#39;c&#39;");
  });

  it("returns an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("html tagged template", () => {
  it("auto-escapes interpolated strings", () => {
    const name = "<img src=x>";
    const out = html`<p>Hello ${name}</p>`.value;
    expect(out).toBe("<p>Hello &lt;img src=x&gt;</p>");
  });

  it("passes through RawHtml as-is", () => {
    const child = raw("<strong>bold</strong>");
    const out = html`<p>${child}</p>`.value;
    expect(out).toBe("<p><strong>bold</strong></p>");
  });

  it("renders arrays of RawHtml by concatenation", () => {
    const items = ["a", "b", "c"].map((s) => html`<li>${s}</li>`);
    const out = html`<ul>
      ${items}
    </ul>`.value;
    expect(out).toContain("<li>a</li><li>b</li><li>c</li>");
  });

  it("drops null and undefined values silently", () => {
    const out = html`<p>${null}${undefined}x</p>`.value;
    expect(out).toBe("<p>x</p>");
  });
});
