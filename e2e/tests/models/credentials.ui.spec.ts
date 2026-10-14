// SPDX-License-Identifier: Apache-2.0

/**
 * The « Clés org » tab of org settings → Modèles: what a saved key shows, and
 * what happens when one is deleted while a model still runs on it.
 *
 * `org_models.credential_id` is ON DELETE RESTRICT, so the server refuses such
 * a delete. The page knows the models already and says so in the confirmation
 * before the server has to: it names them, and the confirm button stays out of
 * reach until they are gone. Both halves are pinned here: the refusal with the
 * models named, and the delete that goes through once nothing binds to the key.
 *
 * Nothing here talks to a model provider: the keys are rows, never used.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { MODELS_SETTINGS_PATH } from "../../helpers/models.ts";
import { openRowMenuItem } from "../../helpers/table.ts";
import type { ApiClient } from "../../helpers/api-client.ts";
import type { Locator, Page } from "@playwright/test";

const DELETE = "Supprimer";
const MODEL_ID = "claude-sonnet-4-5-20250929";

type Client = Pick<ApiClient, "post" | "get">;

async function seedKey(
  apiClient: Client,
  body: Record<string, unknown>,
): Promise<{ id: string; label: string }> {
  const res = await apiClient.post("/model-provider-credentials", body);
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; label: string };
}

async function seedModel(
  apiClient: Client,
  credentialId: string,
  modelId: string,
): Promise<{ id: string; label: string }> {
  const res = await apiClient.post("/models", { modelId, credentialId });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; label: string };
}

async function openKeysTab(page: Page): Promise<void> {
  await page.goto(MODELS_SETTINGS_PATH);
  await expect(page.getByRole("tab", { name: "Clés org", selected: true })).toBeVisible();
}

/** A key's row, found by its name (the name is unique to the test that seeded it). */
function keyRow(page: Page, label: string): Locator {
  return page.getByRole("row").filter({ hasText: label });
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
      api_key: "e2e-key",
      base_url_override: "https://vllm.internal.test/v1",
    });

    await openKeysTab(page);
    const row = keyRow(page, key.label);
    await expect(row).toBeVisible();
    // The name is the first cell and carries the icon; the « … » menu lives in the last.
    await expect(row.getByRole("cell").first().locator("svg")).toHaveCount(1);
  });

  test("refuses to delete a key a model runs on, then deletes it once the model is gone", async ({
    authedPage: page,
    apiClient,
  }) => {
    const key = await seedKey(apiClient, {
      providerId: "openai-compatible",
      api_key: "e2e-key",
      base_url_override: "https://vllm.internal.test/v1",
    });
    const model = await seedModel(apiClient, key.id, "vllm-model");
    // A second key and its model, which the delete must leave alone.
    const otherKey = await seedKey(apiClient, { providerId: "anthropic", api_key: "sk-ant-e2e" });
    const otherModel = await seedModel(apiClient, otherKey.id, MODEL_ID);

    await openKeysTab(page);
    await openRowMenuItem(page, key.label, DELETE);
    const dialog = page.getByRole("dialog", { name: "Supprimer la clé ?" });
    await expect(dialog).toBeVisible();
    // The page names the models on the key itself, so the operator learns
    // what to do first instead of a refusal after the click.
    await expect(
      dialog.getByText(`La clé « ${key.label} » est utilisée par 1 modèle : ${model.label}.`),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: DELETE, exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Annuler" }).click();
    await expect(dialog).toBeHidden();
    await expect(keyRow(page, key.label)).toBeVisible();

    expect((await apiClient.delete(`/models/${model.id}`)).status()).toBe(204);
    await openKeysTab(page);
    await openRowMenuItem(page, key.label, DELETE);
    await expect(dialog.getByText(`Supprimer la clé « ${key.label} » ?`)).toBeVisible();
    await dialog.getByRole("button", { name: DELETE, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(keyRow(page, key.label)).toHaveCount(0);

    const models = (await (await apiClient.get("/models")).json()).data as Array<{ id: string }>;
    expect(models.find((m) => m.id === otherModel.id)).toBeDefined();
    await expect(keyRow(page, otherKey.label)).toBeVisible();
  });
});
