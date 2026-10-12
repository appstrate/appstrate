// SPDX-License-Identifier: Apache-2.0

/**
 * The « Clés org » tab of org settings → Modèles: what a saved key shows, and
 * what deleting one costs.
 *
 * `org_models.credential_id` is ON DELETE RESTRICT, so the server refuses to
 * delete a key a model still references. The page does not leave that to the
 * server: the confirmation says which models lose their access, and on
 * confirmation the interface removes the key's models and then the key, in one
 * gesture. When the key serves the organization's default model the
 * confirmation first asks for the model that replaces it. Both halves are
 * pinned here.
 *
 * Nothing here talks to a model provider: the keys are rows, never used.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { MODELS_SETTINGS_PATH } from "../../helpers/models.ts";
import { openRowMenuItem } from "../../helpers/table.ts";
import type { APIResponse, Locator, Page } from "@playwright/test";

const DELETE = "Supprimer";
const MODEL_ID = "claude-sonnet-4-5-20250929";
const OTHER_MODEL_ID = "claude-opus-4-7";

type Client = {
  post(path: string, data?: unknown): Promise<APIResponse>;
  get(path: string): Promise<APIResponse>;
};

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

  test("says what deleting a key costs, then removes the key and its models in one gesture", async ({
    authedPage: page,
    apiClient,
  }) => {
    // The first key serves the organization's default model, the second one a
    // model nobody defaults to.
    const defaultKey = await seedKey(apiClient, { providerId: "anthropic", api_key: "sk-ant-e2e" });
    const defaultModel = await seedModel(apiClient, defaultKey.id, MODEL_ID);
    const otherKey = await seedKey(apiClient, {
      providerId: "openai-compatible",
      api_key: "e2e-key",
      base_url_override: "https://vllm.internal.test/v1",
    });
    const otherModel = await seedModel(apiClient, otherKey.id, "vllm-model");

    await openKeysTab(page);
    await openRowMenuItem(page, otherKey.label, DELETE);
    const dialog = page.getByRole("dialog", { name: "Supprimer la clé ?" });
    await expect(dialog).toBeVisible();
    // The page counts the models on the key itself, so the operator learns
    // what the delete costs instead of a refusal after the click.
    await expect(
      dialog.getByText(
        `Supprimer la clé « ${otherKey.label} » ? Son modèle ne sera plus accessible`,
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Annuler" }).click();
    await expect(dialog).toBeHidden();
    await expect(keyRow(page, otherKey.label)).toBeVisible();

    await openRowMenuItem(page, otherKey.label, DELETE);
    await dialog.getByRole("button", { name: DELETE, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(keyRow(page, otherKey.label)).toHaveCount(0);
    // One gesture: the model went with its key, and nothing else did.
    const models = (await (await apiClient.get("/models")).json()).data as Array<{ id: string }>;
    expect(models.find((m) => m.id === otherModel.id)).toBeUndefined();
    expect(models.find((m) => m.id === defaultModel.id)).toBeDefined();
  });

  test("asks for the model that replaces the default before deleting the key that serves it", async ({
    authedPage: page,
    apiClient,
  }) => {
    const defaultKey = await seedKey(apiClient, {
      providerId: "anthropic",
      api_key: "sk-ant-e2e",
      label: "Clé du défaut",
    });
    const defaultModel = await seedModel(apiClient, defaultKey.id, MODEL_ID);
    const otherKey = await seedKey(apiClient, {
      providerId: "anthropic",
      api_key: "sk-ant-e2e-2",
      label: "Clé de secours",
    });
    const otherModel = await seedModel(apiClient, otherKey.id, OTHER_MODEL_ID);

    await openKeysTab(page);
    await openRowMenuItem(page, defaultKey.label, DELETE);
    const dialog = page.getByRole("dialog", { name: "Supprimer la clé ?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("est le modèle par défaut de l'organisation")).toBeVisible();
    // Out of reach until the replacement is chosen.
    const confirm = dialog.getByRole("button", { name: DELETE, exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.locator("#delete-key-new-default").click();
    await page.getByRole("option", { name: otherModel.label }).click();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(dialog).toBeHidden();
    await expect(keyRow(page, defaultKey.label)).toHaveCount(0);
    const models = (await (await apiClient.get("/models")).json()).data as Array<{
      id: string;
      is_default: boolean;
    }>;
    expect(models.find((m) => m.id === defaultModel.id)).toBeUndefined();
    expect(models.find((m) => m.id === otherModel.id)?.is_default).toBe(true);
  });
});
