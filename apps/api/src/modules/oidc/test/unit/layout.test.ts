// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared OIDC page layout (`renderLayout`): document
 * skeleton, branding, escaping, the optional no-referrer meta, and the styles
 * of the emergency sign-in block the enterprise SSO login page appends.
 */

import { describe, it, expect } from "bun:test";
import { renderLayout } from "../../pages/layout.ts";
import { html } from "../../pages/html.ts";
import { PLATFORM_DEFAULT_BRANDING } from "../../services/branding.ts";

function render(over: Partial<Parameters<typeof renderLayout>[0]> = {}): string {
  return renderLayout({
    branding: PLATFORM_DEFAULT_BRANDING,
    title: "Connexion",
    bodyHtml: html`<main>body</main>`,
    maxWidth: 400,
    ...over,
  }).value;
}

describe("renderLayout", () => {
  it("renders the document skeleton with the title, the body and the column width", () => {
    const out = render({ maxWidth: 440 });
    expect(out).toContain("<!doctype html>");
    expect(out).toContain("<title>Connexion</title>");
    expect(out).toContain("max-width: 440px");
    expect(out).toContain("<main>body</main>");
  });

  it("escapes the title", () => {
    const out = render({ title: "<script>alert(1)</script>" });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("emits the no-referrer meta only when asked", () => {
    expect(render()).not.toContain('name="referrer"');
    expect(render({ noReferrer: true })).toContain(
      '<meta name="referrer" content="no-referrer" />',
    );
  });

  it("ships the styles of the emergency sign-in block", () => {
    const out = render();
    expect(out).toContain(".emergency {");
    expect(out).toContain(".emergency summary {");
    expect(out).toContain(".emergency form {");
  });
});
