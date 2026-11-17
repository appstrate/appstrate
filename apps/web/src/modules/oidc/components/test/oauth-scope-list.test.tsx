// SPDX-License-Identifier: Apache-2.0

/**
 * The scope checklist of the OAuth client modal draws nothing from a default
 * while the catalogue is on its way: a skeleton, not the three required scopes
 * (which the full list would then grow past). A failed read says so.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../../i18n.ts";
import { render } from "../../../../test/render.tsx";
import { ScopeList } from "../oauth-client-form-modal.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const selected = new Set(["openid", "profile", "email"]);

function list(scopes: string[] | undefined, error: unknown = null): string {
  return render(
    <ScopeList scopes={scopes} error={error} selected={selected} onToggle={() => {}} />,
  );
}

describe("ScopeList", () => {
  it("draws a skeleton, no checkbox, while the catalogue loads", () => {
    const html = list(undefined);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("oauth-scope-openid");
  });

  it("says so when the catalogue read failed", () => {
    const html = list(undefined, new Error("boom"));
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("oauth-scope-openid");
  });

  it("draws the server's list once known", () => {
    const html = list(["openid", "profile", "email", "offline_access"]);
    expect(html).toContain("oauth-scope-offline_access");
  });
});
