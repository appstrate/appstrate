// SPDX-License-Identifier: Apache-2.0

/**
 * Browser smoke tests for OAuth Model Providers UI flow
 * (`apps/web/src/pages/org-settings/models.tsx` +
 * `apps/web/src/components/oauth-model-provider-dialog.tsx`).
 *
 * What we cover:
 *   - The "Add" dropdown surfaces the two OAuth options (Codex + Claude).
 *   - Selecting Claude opens the ToS-warning modal showing the explicit
 *     mention of Anthropic's 2026-01-09 enforcement.
 *   - The "Continuer" button is disabled until both the consent checkbox
 *     is checked AND the label is non-empty.
 *   - Once advanced to the CLI stage, the modal renders the exact
 *     `bunx @appstrate/cli@latest connect <slug> --label='…'` command and
 *     the polling spinner.
 *   - The settings page surfaces a toast when redirected with `?oauthError=…`
 *     (kept for backwards-compat with any in-flight state from older
 *     browser sessions).
 *
 * The legacy "redirect to auth.openai.com" path is gone — see
 * `docs/architecture/OAUTH_MODEL_PROVIDERS_PLAN.md` Phase 9 / Phase 10.
 *
 * @tags @smoke
 */

import { test, expect, type Page } from "../../fixtures/browser.fixture.ts";

const SETTINGS_PATH = "/org-settings/models";

/**
 * Open the settings page and switch to the "Provider keys" sub-tab where
 * the OAuth dropdown lives.
 */
async function gotoProviderKeysTab(page: Page): Promise<void> {
  await page.goto(SETTINGS_PATH);
  await page
    .getByRole("tab", { name: /(Model Provider Keys|Clés de providers de modèles)/i })
    .click();
}

test.describe("OAuth Model Providers — UI smoke", () => {
  test("Add dropdown lists Codex + Claude OAuth options @smoke", async ({ authedPage: page }) => {
    await gotoProviderKeysTab(page);

    const addButton = page.getByRole("button", { name: /^(Add key|Ajouter une clé)/i });
    await expect(addButton).toBeVisible();
    await addButton.click();

    // Both OAuth options should appear in the dropdown menu.
    await expect(page.getByText(/ChatGPT.*Plus.*Pro.*Business/i)).toBeVisible();
    await expect(page.getByText(/Claude.*Pro.*Max.*Team/i)).toBeVisible();
  });

  test("Claude opens ToS warning with 2026-01-09 enforcement notice @smoke", async ({
    authedPage: page,
  }) => {
    await gotoProviderKeysTab(page);

    await page.getByRole("button", { name: /^(Add key|Ajouter une clé)/i }).click();
    await page.getByText(/Claude.*Pro.*Max.*Team/i).click();

    // Stage 1 title.
    await expect(page.getByText(/(Before you continue|Avant de continuer)/i)).toBeVisible();

    // The Anthropic-specific enforcement banner.
    await expect(
      page.getByText(/(Anthropic blocks this usage|Anthropic bloque cet usage)/i),
    ).toBeVisible();
    // Date is the load-bearing detail — assert verbatim.
    await expect(page.locator("[role='dialog']")).toContainText("2026-01-09");
  });

  test("Continuer is disabled until consent + label, advances to CLI stage @smoke", async ({
    authedPage: page,
  }) => {
    await gotoProviderKeysTab(page);
    await page.getByRole("button", { name: /^(Add key|Ajouter une clé)/i }).click();
    await page.getByText(/ChatGPT.*Plus.*Pro.*Business/i).click();

    const continueBtn = page.getByRole("button", { name: /(Continue|Continuer)/i });
    // Continuer disabled while checkbox unchecked.
    await expect(continueBtn).toBeDisabled();

    // Tick the consent checkbox; label is pre-filled to "ChatGPT".
    await page.locator("#oauth-tos-accept").click();
    await expect(continueBtn).toBeEnabled();

    // Type a custom label, then advance.
    const labelInput = page.locator("#oauth-label");
    await labelInput.fill("E2E Smoke Codex");
    await continueBtn.click();

    // Stage 2 — CLI command rendered with our label, single-quoted.
    const dialog = page.locator("[role='dialog']");
    await expect(dialog.getByText(/(Connect via CLI|Connecter via la CLI)/i)).toBeVisible();
    await expect(dialog.locator("code")).toContainText(
      "bunx @appstrate/cli@latest connect codex --label='E2E Smoke Codex'",
    );
    // Polling spinner copy.
    await expect(
      dialog.getByText(/(Waiting for the connection|En attente de la connexion)/i),
    ).toBeVisible();
  });

  test("?oauthError query param surfaces an error toast", async ({ authedPage: page }) => {
    await page.goto(`${SETTINGS_PATH}?oauthError=access%20denied`);
    await expect(page.locator("body")).toContainText(/access\s*denied/i, { timeout: 5_000 });
  });
});
