// SPDX-License-Identifier: Apache-2.0

/**
 * Browser smoke tests for OAuth Model Providers UI flow
 * (`apps/web/src/pages/org-settings/models.tsx` +
 * `apps/web/src/components/oauth-model-provider-dialog.tsx`).
 *
 * What we cover:
 *   - The "Add" dropdown surfaces the two OAuth options (Codex + Claude).
 *   - Clicking either opens the ToS-warning modal (stage 1 of 2).
 *   - Continuing past the warning shows the label-entry stage and
 *     hitting "Continuer" calls `/api/model-providers-oauth/initiate`.
 *   - The settings page surfaces a toast when redirected back with
 *     `?oauthError=...` (the failure side of the OAuth dance).
 *
 * We intercept the actual redirect to the OAuth provider so the test
 * never leaves localhost (the redirect target is `auth.openai.com` /
 * `claude.ai`, both unreachable / hostile in CI).
 *
 * @tags @smoke
 */

import { test, expect, type Page } from "../../fixtures/browser.fixture.ts";

const SETTINGS_PATH = "/org-settings/models";

/**
 * Open the settings page and switch to the "Provider keys" sub-tab where
 * the OAuth dropdown lives. The page has two tabs:
 *   - "Modèles" / "Models" (default — model list)
 *   - "Clés de providers de modèles" / "Model Provider Keys" (OAuth lives here)
 */
async function gotoProviderKeysTab(page: Page): Promise<void> {
  await page.goto(SETTINGS_PATH);
  // Wait for the SPA to mount — the Provider Keys tab is in <Tabs>.
  await page
    .getByRole("tab", { name: /(Model Provider Keys|Clés de providers de modèles)/i })
    .click();
}

test.describe("OAuth Model Providers — UI smoke", () => {
  test("Add dropdown lists Codex + Claude OAuth options @smoke", async ({ authedPage: page }) => {
    await gotoProviderKeysTab(page);

    // The "Add key" button on the Provider Keys tab is the dropdown trigger.
    // FR: "Ajouter une clé" — EN: "Add key".
    const addButton = page.getByRole("button", { name: /^(Add key|Ajouter une clé)/i });
    await expect(addButton).toBeVisible();
    await addButton.click();

    // Both OAuth options should appear in the dropdown menu.
    await expect(page.getByText(/ChatGPT.*Plus.*Pro.*Business/i)).toBeVisible();
    await expect(page.getByText(/Claude.*Pro.*Max.*Team/i)).toBeVisible();
  });

  test("Selecting Claude opens the ToS warning modal @smoke", async ({ authedPage: page }) => {
    await gotoProviderKeysTab(page);

    await page.getByRole("button", { name: /^(Add key|Ajouter une clé)/i }).click();
    await page.getByText(/Claude.*Pro.*Max.*Team/i).click();

    // Stage 1: ToS title visible — "Avant de continuer" / "Before you continue".
    await expect(page.getByText(/(Before you continue|Avant de continuer)/i)).toBeVisible();

    // Cancel closes the dialog without firing the OAuth flow.
    await page.getByRole("button", { name: /(Cancel|Annuler)/i }).click();
    await expect(page.getByText(/(Before you continue|Avant de continuer)/i)).not.toBeVisible();
  });

  test("Walking through the dialog calls /initiate and redirects to the provider @smoke", async ({
    authedPage: page,
  }) => {
    // Intercept the upstream redirect FIRST — Playwright would otherwise follow
    // it to https://auth.openai.com which is unreachable / off-network.
    let interceptedRedirect: string | null = null;
    await page.route("https://auth.openai.com/**", (route) => {
      interceptedRedirect = route.request().url();
      return route.fulfill({ status: 200, body: "<html>mock provider page</html>" });
    });

    let initiateRequest: { providerPackageId: string; label: string } | null = null;
    await page.route("**/api/model-providers-oauth/initiate", async (route) => {
      const body = route.request().postDataJSON() as {
        providerPackageId: string;
        label: string;
      };
      initiateRequest = body;
      return route.continue();
    });

    await gotoProviderKeysTab(page);

    await page.getByRole("button", { name: /^(Add key|Ajouter une clé)/i }).click();
    await page.getByText(/ChatGPT.*Plus.*Pro.*Business/i).click();

    // Stage 1 → Stage 2: click "Continuer" / "Continue" to move past ToS.
    await page.getByRole("button", { name: /(Continue|Continuer)/i }).click();

    // Stage 2: Label input is autofocused. Type a name and submit.
    const labelInput = page.locator("#oauth-label");
    await expect(labelInput).toBeVisible();
    await labelInput.fill("E2E ChatGPT Pro");

    await page.getByRole("button", { name: /(Continue|Continuer)/i }).click();

    // The /initiate request fired with our payload.
    await expect.poll(() => initiateRequest).not.toBeNull();
    expect(initiateRequest!.providerPackageId).toBe("@appstrate/provider-codex");
    expect(initiateRequest!.label).toBe("E2E ChatGPT Pro");

    // The full-page redirect to auth.openai.com landed (and we intercepted it).
    await expect.poll(() => interceptedRedirect).not.toBeNull();
    expect(interceptedRedirect!).toContain("auth.openai.com/oauth/authorize");
    expect(interceptedRedirect!).toContain("code_challenge_method=S256");
    expect(interceptedRedirect!).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
  });

  test("?oauthError query param surfaces an error toast", async ({ authedPage: page }) => {
    await page.goto(`${SETTINGS_PATH}?oauthError=access%20denied`);
    // Toast region renders the localized callbackError string. We don't pin
    // the exact wording — the param being reflected anywhere in the document
    // proves the handler ran.
    await expect(page.locator("body")).toContainText(/access\s*denied/i, { timeout: 5_000 });
  });
});
