// SPDX-License-Identifier: Apache-2.0

/**
 * Browser smoke tests for the OAuth Model Providers UI surface
 * (`apps/web/src/pages/org-settings/models.tsx`).
 *
 * The `/initiate` + `/callback` browser flow + the `?oauthError=` toast
 * mechanism were removed when the pairing flow replaced platform-hosted
 * OAuth callbacks (public CLI client_ids only allowlist
 * `http://localhost:PORT/...` redirect_uris baked into the provider
 * CLIs, so any dashboard-hosted callback is rejected upstream).
 * Provider-specific UX — which OAuth slugs appear, per-provider ToS
 * warning copy, the CLI command rendered in the pairing-token stage —
 * is covered by each module's own e2e suite. The platform e2e stays
 * provider-agnostic and asserts only that the OAuth-aware models page
 * renders for an authenticated admin.
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";

const SETTINGS_PATH = "/org-settings/models";

test.describe("OAuth Model Providers — UI smoke", () => {
  test("models settings page renders for an authenticated admin", async ({ authedPage: page }) => {
    await page.goto(SETTINGS_PATH);
    // Both tabs are gated on `isAdmin` — their presence proves the page
    // mounted and the admin guard let us through. The tab labels come
    // from i18n (`models.tabTitle` / `providerKeys.title`), so we match
    // on their stable English fallback substrings rendered as French in
    // the default locale.
    await expect(page.getByRole("tab", { name: "Modèles", exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("tab", { name: "Clés de providers de modèles", exact: true }),
    ).toBeVisible();
  });
});
