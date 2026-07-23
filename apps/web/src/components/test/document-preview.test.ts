// SPDX-License-Identifier: Apache-2.0

/**
 * Security regression guard for the preview iframe sandbox.
 *
 * The preview iframe renders UNTRUSTED agent HTML; its `sandbox` MUST stay
 * exactly `"allow-scripts"`. Widening it (notably adding `allow-same-origin`,
 * which combined with `allow-scripts` defeats the sandbox) is a serious
 * vulnerability, so this test fails the build if the value drifts OR if the JSX
 * stops sourcing it from the shared constant (a hardcoded attribute could widen
 * silently). Source-scanned rather than DOM-rendered — the web test runner has
 * no DOM, and this catches both failure modes without one.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../document-preview.tsx", import.meta.url)),
  "utf-8",
);

describe("DocumentPreview iframe sandbox", () => {
  it("declares the sandbox constant as exactly 'allow-scripts'", () => {
    const match = /export const PREVIEW_IFRAME_SANDBOX = "([^"]*)";/.exec(source);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("allow-scripts");
  });

  it("never combines allow-scripts with any origin/navigation/form/popup permission", () => {
    const value = /export const PREVIEW_IFRAME_SANDBOX = "([^"]*)";/.exec(source)![1]!;
    for (const forbidden of [
      "allow-same-origin",
      "allow-popups",
      "allow-forms",
      "allow-top-navigation",
      "allow-modals",
    ]) {
      expect(value).not.toContain(forbidden);
    }
  });

  it("sources the iframe sandbox attribute from the shared constant (no hardcoded widening)", () => {
    expect(source).toContain("sandbox={PREVIEW_IFRAME_SANDBOX}");
    expect(source).toContain('referrerPolicy="no-referrer"');
  });

  it("uses a JSX sandbox attribute exactly ONCE — only the html iframe (the pdf iframe stays sandboxless)", () => {
    // A second JSX `sandbox={…}` would mean another frame (notably the pdf
    // iframe, which MUST stay sandboxless for Chrome's native viewer) grew a
    // sandbox, or a hardcoded one appeared. Pinning to a single occurrence
    // sourced from the constant keeps the html path the only sandboxed frame.
    const occurrences = source.match(/sandbox=\{/g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(source).toContain("sandbox={PREVIEW_IFRAME_SANDBOX}");
  });
});

describe("DocumentPreview kind branching", () => {
  it("branches on preview_kind for image / pdf / text (html is the default)", () => {
    expect(source).toContain('kind === "image"');
    expect(source).toContain('kind === "pdf"');
    expect(source).toContain('kind === "text"');
  });

  it("renders images via an <img> (not an iframe) with the doc name as alt", () => {
    expect(source).toContain("<img");
    expect(source).toContain("alt={doc.name}");
  });
});

describe("DocumentPreview non-previewable fallback", () => {
  it("auto-downloads then closes when a settled DTO has no preview_url", () => {
    // Non-previewable docs (no server-minted preview_url) must download instead
    // of showing a dead-end error — the single branch every consumer relies on.
    expect(source).toContain("if (data.preview_url) return;");
    expect(source).toContain("void download(doc.id, doc.name)");
    expect(source).toContain("onClose();");
  });
});

describe("DocumentPreview markdown rendering", () => {
  it("renders markdown docs via the sanitized Markdown component, client-side", () => {
    // Rich markdown must go through the React `Markdown` component (same
    // sanitization/trust as the run report), never the inert text/plain iframe.
    expect(source).toContain('import { Markdown } from "./markdown"');
    expect(source).toContain("function MarkdownPreview(");
    expect(source).toContain("<MarkdownPreview");
  });

  it("detects markdown by text/markdown mime (tolerating params) or a .md text-ish file", () => {
    expect(source).toContain('m === "text/markdown"');
    expect(source).toContain('m.startsWith("text/markdown;")');
    expect(source).toContain('name.toLowerCase().endsWith(".md")');
  });

  it("caps inline markdown at 1 MiB and falls back above it", () => {
    // Oversized md skips the fetch/render and drops through to the existing
    // text preview / download path.
    expect(source).toContain("const INLINE_MARKDOWN_MAX_BYTES = 1_048_576");
    expect(source).toContain("data.size <= INLINE_MARKDOWN_MAX_BYTES");
  });

  it("fetches markdown bytes authenticated via the typed client (not the preview URL)", () => {
    expect(source).toContain('client.GET("/api/documents/{id}/content"');
    expect(source).toContain('parseAs: "text"');
  });

  it("gates the markdown branch on isMarkdownDoc so non-markdown kinds are unchanged", () => {
    // image/pdf/text/html branches are only reached for non-markdown docs.
    expect(source).toContain("isMarkdownDoc(data.mime, doc.name)");
    expect(source).toContain('kind === "image"');
    expect(source).toContain('kind === "pdf"');
    expect(source).toContain('kind === "text"');
  });
});
