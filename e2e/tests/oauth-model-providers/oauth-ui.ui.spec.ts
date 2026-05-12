// SPDX-License-Identifier: Apache-2.0

/**
 * Browser smoke tests for OAuth Model Providers UI flow
 * (`apps/web/src/pages/org-settings/models.tsx` +
 * `apps/web/src/components/oauth-model-provider-dialog.tsx`).
 *
 * Provider-specific UX (which OAuth slugs appear in the "Add" dropdown,
 * per-provider ToS warning copy, the CLI command rendered in the
 * pairing-token stage) is covered by each module's own e2e suite under
 * `packages/module-*/e2e/` and the platform e2e stays provider-agnostic.
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";

const SETTINGS_PATH = "/org-settings/models";

test.describe("OAuth Model Providers — UI smoke", () => {
  test("?oauthError query param surfaces an error toast", async ({ authedPage: page }) => {
    await page.goto(`${SETTINGS_PATH}?oauthError=access%20denied`);
    await expect(page.locator("body")).toContainText(/access\s*denied/i, { timeout: 5_000 });
  });
});
