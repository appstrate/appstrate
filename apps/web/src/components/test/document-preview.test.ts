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
});
