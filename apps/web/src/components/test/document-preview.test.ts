// SPDX-License-Identifier: Apache-2.0

/**
 * Security regression guard for the preview iframe sandbox — the one thing about
 * the reusable viewer a test can meaningfully protect.
 *
 * The preview iframe renders UNTRUSTED agent HTML; its `sandbox` MUST stay
 * exactly `"allow-scripts"`. Widening it (notably adding `allow-same-origin`,
 * which combined with `allow-scripts` defeats the sandbox) is a serious
 * vulnerability, so these tests fail the build if the value drifts OR if the JSX
 * stops sourcing it from the shared constant (a hardcoded attribute could widen
 * silently). Source-scanned rather than imported: the component pulls in the
 * Vite-only API client (`import.meta.glob`), which the bun test runner cannot
 * evaluate — and a scan is what checks the JSX attribute anyway.
 *
 * Everything else this file used to assert was a `toContain` scan of the
 * viewer's own source — proving nothing about behavior and breaking on any
 * rename. The one real behavior in there (markdown detection) moved to
 * `lib/test/documents.test.ts`, where the helper now lives.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../document-viewer.tsx", import.meta.url)),
  "utf-8",
);

/** The declared sandbox token set, read straight out of the viewer source. */
function declaredSandbox(): string {
  const match = /export const PREVIEW_IFRAME_SANDBOX = "([^"]*)";/.exec(source);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe("DocumentViewer iframe sandbox", () => {
  it("declares the sandbox constant as exactly 'allow-scripts'", () => {
    expect(declaredSandbox()).toBe("allow-scripts");
  });

  it("never combines allow-scripts with any origin/navigation/form/popup permission", () => {
    for (const forbidden of [
      "allow-same-origin",
      "allow-popups",
      "allow-forms",
      "allow-top-navigation",
      "allow-modals",
    ]) {
      expect(declaredSandbox()).not.toContain(forbidden);
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
  });

  it("never injects preview content as raw HTML", () => {
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
});
