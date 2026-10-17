// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  EXCERPT_READ_BYTES,
  excerptKind,
  extractExcerpt,
  readPrefix,
} from "../../../src/services/file-excerpt.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const excerpt = (kind: "markdown" | "text" | "html", s: string, truncated = false) =>
  extractExcerpt(kind, bytes(s), truncated);

describe("excerptKind", () => {
  it("maps the excerpted mimes, ignoring parameters and case", () => {
    expect(excerptKind("text/markdown; charset=utf-8", "a")).toBe("markdown");
    expect(excerptKind("TEXT/HTML", "a")).toBe("html");
    expect(excerptKind("text/plain", "a")).toBe("text");
    expect(excerptKind("text/csv", "a")).toBe("text");
    expect(excerptKind("application/json", "a")).toBe("text");
  });

  it("reads a .md under any text mime as markdown", () => {
    expect(excerptKind("text/plain", "notes.MD")).toBe("markdown");
    expect(excerptKind("text/x-markdown", "notes.md")).toBe("markdown");
    expect(excerptKind("application/octet-stream", "notes.md")).toBeNull();
  });

  it("has no excerpt for any other type", () => {
    for (const mime of ["application/pdf", "image/png", "image/svg+xml", "application/xml", ""]) {
      expect(excerptKind(mime, "a.pdf")).toBeNull();
    }
  });
});

describe("extractExcerpt — markdown", () => {
  it("keeps headings and text, drops the syntax", async () => {
    const md = [
      "---",
      "name: report",
      "---",
      "# Weekly *report* #",
      "",
      "Some **bold**, _italic_ and ~~struck~~ text with a [link](https://x.test) and `code`.",
      "![chart](chart.png) snake_case_name stays.",
      "",
      "> a quote",
      "- item one",
      "2. item two",
      "- [x] done",
      "",
      "| a | b |",
      "|---|:-:|",
      "| 1 | 2 |",
      "",
      "```js",
      "run()",
      "```",
      "<div>inline html</div> &amp; \\*escaped\\*",
      "<!-- hidden note -->",
      "***",
      "[ref]: https://x.test",
      "Setext",
      "======",
    ].join("\n");
    expect(await excerpt("markdown", md)).toBe(
      [
        "Weekly report",
        "Some bold, italic and struck text with a link and code.",
        "chart snake_case_name stays.",
        "a quote",
        "item one",
        "item two",
        "done",
        "a b",
        "1 2",
        "run()",
        "inline html & *escaped*",
        "Setext",
      ].join("\n"),
    );
  });
});

describe("extractExcerpt — plain text, csv, json", () => {
  it("gives the first lines, whitespace collapsed and blank lines dropped", async () => {
    expect(await excerpt("text", "  first   line  \r\n\r\n\tsecond\n")).toBe("first line\nsecond");
    expect(await excerpt("text", "name,qty\nApple,3\n")).toBe("name,qty\nApple,3");
    expect(await excerpt("text", '{\n  "a": 1\n}')).toBe('{\n"a": 1\n}');
  });

  it("leaves entities alone in plain text", async () => {
    expect(await excerpt("text", "a &amp; b")).toBe("a &amp; b");
  });

  it("is null when there is no text", async () => {
    expect(await excerpt("text", " \n\t\n")).toBeNull();
    expect(await excerpt("markdown", "---\n***\n")).toBeNull();
  });
});

describe("extractExcerpt — html", () => {
  it("gives the title and the visible text only", async () => {
    const html = `<!doctype html><html><head>
      <title>Rapport &amp; bilan</title>
      <style>body { color: red }</style>
      <script>alert(1)</script>
    </head><body>
      <h1>Rapport &amp; bilan</h1>
      <p title="attribute text" data-x="secret attr">Caf&eacute; &#233;t&#xE9; &lt;b&gt; &nbsp;<!-- secret comment --><b>bold</b>er</p>
      <p>Second</p>
      <script type="module">document.write("x")</script>
      <noscript>enable js</noscript><template><p>tpl</p></template>
      <svg><title>icon</title><text>svg text</text></svg>
      <table><tr><td>a</td><td>b</td></tr></table>
      &unknown; &#0;
    </body></html>`;
    const out = await excerpt("html", html);
    expect(out).toBe("Rapport & bilan\nCafé été <b> bolder\nSecond\na b\n&unknown; �");
    for (const leak of [
      "alert",
      "color",
      "secret",
      "attribute",
      "enable js",
      "tpl",
      "icon",
      "svg",
    ]) {
      expect(out).not.toContain(leak);
    }
  });

  it("leaves no tag or comment opener assembled by stripping", async () => {
    const tag = (await excerpt("markdown", "<scr<script>ipt>alert(1)</script>")) ?? "";
    expect(tag).not.toContain("<script");
    const comment = (await excerpt("markdown", "a <!<!---->-- b")) ?? "";
    expect(comment).not.toContain("<!--");
  });

  it("skips form controls and a title the first heading starts with", async () => {
    const html = `<title>Rapport des ventes</title><h1>rapport des ventes du trimestre</h1>
      <p>Les ventes ont progressé</p><button>+1</button><select><option>opt</option></select>
      <textarea>draft</textarea><span>0</span>`;
    expect(await excerpt("html", html)).toBe(
      "rapport des ventes du trimestre\nLes ventes ont progressé\n0",
    );
  });

  it("works without head or body tags", async () => {
    expect(await excerpt("html", "just <em>text</em>")).toBe("just text");
  });

  it("is null for markup without visible text", async () => {
    expect(await excerpt("html", "<style>a{}</style><script>x()</script>")).toBeNull();
  });
});

describe("extractExcerpt — length and cut", () => {
  it("caps at 400 characters on a word, with an ellipsis", async () => {
    const out = (await excerpt("text", "word ".repeat(200)))!;
    expect(out.endsWith("word…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(401);
    expect(out.length).toBeGreaterThan(320);
  });

  it("never splits a grapheme at the limit", async () => {
    const family = "👨‍👩‍👧"; // one grapheme, 8 UTF-16 units
    const out = (await excerpt("text", "a".repeat(396) + family + "tail"))!;
    expect(out).toBe("a".repeat(396) + "…");
  });

  it("drops a multibyte character cut by a truncated read, and marks the cut", async () => {
    const full = bytes("Été é");
    const cut = full.subarray(0, full.byteLength - 1); // half of the final "é"
    expect(await extractExcerpt("text", cut, true)).toBe("Été…");
  });

  it("does not mark an untruncated short text", async () => {
    expect(await excerpt("text", "short")).toBe("short");
  });
});

describe("extractExcerpt — adversarial input", () => {
  // Each finishes in about a millisecond; the budget leaves room for a slow CI box.
  const BUDGET_MS = 50;
  const cases: [string, "markdown" | "text" | "html", string][] = [
    ["markdown, one line of spaces", "markdown", " ".repeat(65535) + "x"],
    ["markdown, ![ repeated", "markdown", "![".repeat(32768)],
    ["markdown, [ repeated", "markdown", "[".repeat(65536)],
    ["markdown, - [ repeated", "markdown", "- [ ".repeat(16384)],
    ["markdown, <a repeated", "markdown", "<a".repeat(32768)],
    ["markdown, |- repeated", "markdown", "|-".repeat(32768) + "x"],
    ["markdown, unclosed emphasis", "markdown", "*a ".repeat(21845)],
    ["markdown, entities", "markdown", "&a".repeat(32768)],
    ["markdown, full lines of ![", "markdown", ("![".repeat(499) + "\n").repeat(65)],
    [
      "markdown, a read's worth of unclosed emphasis lines",
      "markdown",
      ("*a ".repeat(333) + "\n").repeat(EXCERPT_READ_BYTES.markdown / 1000),
    ],
    ["text, one line of spaces", "text", " ".repeat(65535) + "x"],
    ["html, one line of spaces", "html", `<p>${" ".repeat(65520)}x</p>`],
    ["html, entities", "html", `<p>${"&#1".repeat(21840)}</p>`],
  ];
  for (const [label, kind, input] of cases) {
    it(`${label} completes within budget`, async () => {
      const start = performance.now();
      await excerpt(kind, input, true);
      expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    });
  }

  it("ends the excerpt at an over-long markdown line, marked as cut", async () => {
    const out = (await excerpt("markdown", `${"word ".repeat(300)}\nnever seen`))!;
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("never seen");
  });
});

describe("readPrefix", () => {
  it("reads at most the limit across chunks and cancels the stream", async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(10).fill(pulls));
      },
      cancel() {
        cancelled = true;
      },
    });
    const out = await readPrefix(stream, 25);
    expect(out.byteLength).toBe(25);
    expect(out[24]).toBe(3);
    expect(cancelled).toBe(true);
  });

  it("returns a short stream whole", async () => {
    const out = await readPrefix(new Blob([bytes("abc")]).stream(), 100);
    expect(new TextDecoder().decode(out)).toBe("abc");
  });
});
