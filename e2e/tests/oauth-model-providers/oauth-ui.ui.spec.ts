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
    // The default model's row and the configurations' heading prove the page
    // mounted and the guard let us through. The labels come from i18n
    // (`modelConfigs.default.label` / `modelConfigs.title`), rendered as French
    // in the default locale.
    await expect(page.getByText("Modèle par défaut", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("heading", { name: "Configurations", exact: true })).toBeVisible();
  });
});
