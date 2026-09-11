// SPDX-License-Identifier: Apache-2.0

/**
 * The provider-keys tab of org settings → Modèles: what a saved key shows, and
 * what happens when one is deleted while a model still runs on it.
 *
 * `org_models.credential_id` is ON DELETE RESTRICT, so the server refuses such
 * a delete with a 409. The page knows the models already, and says so in the
 * confirmation before the server has to — the confirm button is out of reach
 * until the models are gone. Both halves are pinned here: the refusal with the
 * count, and the delete that goes through once nothing binds to the key.
 *
 * Nothing here talks to a model provider: the keys are rows, never used.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import type { APIResponse, Locator, Page } from "@playwright/test";

const SETTINGS_PATH = "/org-settings/models";
/** `credentials.title` — the tab, and `credentials.delete` — the row's trash button. */
const CREDENTIALS_TAB = "Clés de providers de modèles";
const DELETE = "Supprimer";
const CONFIRM = "Confirmer";
const MODEL_ID = "claude-sonnet-4-5-20250929";

async function seedKey(
  apiClient: { post(path: string, data?: unknown): Promise<APIResponse> },
  body: Record<string, unknown>,
): Promise<{ id: string; label: string }> {
  const res = await apiClient.post("/model-provider-credentials", body);
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; label: string };
}

async function openCredentialsTab(page: Page): Promise<void> {
  await page.goto(SETTINGS_PATH);
  await page.getByRole("tab", { name: CREDENTIALS_TAB }).click();
}

function credentialRow(page: Page, id: string): Locator {
  return page.getByTestId(`credential-row-${id}`);
}

test.describe("Provider keys — UI", () => {
  test("shows a custom endpoint's key with its wire format's icon", async ({
    authedPage: page,
    apiClient,
  }) => {
    // A host no registry entry knows: the icon can only come from the key's
    // providerId, never from a match on its URL.
    const key = await seedKey(apiClient, {
      providerId: "openai-compatible",
      apiKey: "e2e-key",
      baseUrlOverride: "https://vllm.internal.test/v1",
    });

    await openCredentialsTab(page);
    const row = credentialRow(page, key.id);
    await expect(row).toBeVisible();
    // The provider cell is the first one; the trash icon lives in the last.
    await expect(row.locator("td").first().locator("svg")).toHaveCount(1);
  });

  test("refuses to delete a key a model runs on, then deletes it once the model is gone", async ({
    authedPage: page,
    apiClient,
  }) => {
    const key = await seedKey(apiClient, { providerId: "anthropic", apiKey: "sk-ant-e2e" });
    const created = await apiClient.post("/models", { modelId: MODEL_ID, credentialId: key.id });
    expect(created.status()).toBe(201);
    const model = (await created.json()) as { id: string };

    await openCredentialsTab(page);
    await credentialRow(page, key.id).getByRole("button", { name: DELETE }).click();
    const dialog = page.getByRole("dialog", { name: CONFIRM });
    await expect(dialog).toBeVisible();
    // The page counts the models on the key itself, so the operator learns
    // what to do first instead of a refusal after the click.
    await expect(
      dialog.getByText(`La clé "${key.label}" est utilisée par 1 modèle.`),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: CONFIRM })).toBeDisabled();
    await dialog.getByRole("button", { name: "Annuler" }).click();
    await expect(dialog).toBeHidden();
    await expect(credentialRow(page, key.id)).toBeVisible();

    expect((await apiClient.delete(`/models/${model.id}`)).status()).toBe(204);
    await page.reload();
    await page.getByRole("tab", { name: CREDENTIALS_TAB }).click();
    await credentialRow(page, key.id).getByRole("button", { name: DELETE }).click();
    const confirm = page.getByRole("dialog", { name: CONFIRM });
    await expect(confirm.getByText(`Supprimer la clé "${key.label}" ?`)).toBeVisible();
    await confirm.getByRole("button", { name: CONFIRM }).click();

    await expect(confirm).toBeHidden();
    await expect(credentialRow(page, key.id)).toHaveCount(0);
  });
});
