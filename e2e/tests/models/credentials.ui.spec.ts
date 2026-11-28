// SPDX-License-Identifier: Apache-2.0

/**
 * Org settings → Modèles: a configuration's row, and the connections it holds once open. A
 * connection is deleted from its own menu, a configuration (its connections and models with it)
 * from the row's.
 *
 * Nothing here talks to a model provider: the keys are rows, never used.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { MODELS_SETTINGS_PATH, configRow } from "../../helpers/models.ts";
import type { ApiClient } from "../../helpers/api-client.ts";
import type { Locator, Page } from "@playwright/test";

const DELETE = "Supprimer";
const MODEL_ID = "claude-sonnet-4-5-20250929";

type Client = Pick<ApiClient, "post" | "get">;

/** A gateway configuration on a host no registry entry knows, with its organization key. */
async function seedGateway(
  apiClient: Client,
  label: string,
): Promise<{ configId: string; keyId: string; keyLabel: string }> {
  const config = await apiClient.post("/model-configs", {
    provider_id: "openai-compatible",
    base_url: `https://${label.toLowerCase().replace(/\W+/g, "-")}.internal.test/v1`,
    label,
  });
  expect(config.status(), await config.text()).toBe(201);
  const configId = (await config.json()).id as string;
  const key = await apiClient.post("/model-provider-credentials", {
    providerId: "openai-compatible",
    api_key: "e2e-key",
    config_id: configId,
  });
  expect(key.status(), await key.text()).toBe(201);
  const { id, label: keyLabel } = (await key.json()) as { id: string; label: string };
  return { configId, keyId: id, keyLabel };
}

async function openConfig(page: Page, label: string): Promise<Locator> {
  await page.goto(MODELS_SETTINGS_PATH);
  const row = configRow(page, label);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: `Ouvrir « ${label} »` }).click();
  return row;
}

test.describe("Model configurations — UI", () => {
  test("shows a gateway's row, and its organization connection once open", async ({
    authedPage: page,
    apiClient,
  }) => {
    const label = `Gateway ${Date.now()}`;
    const { keyLabel } = await seedGateway(apiClient, label);

    const row = await openConfig(page, label);
    await expect(row.getByText("Active", { exact: true }).first()).toBeVisible();
    await expect(row.getByTitle(keyLabel, { exact: true })).toBeVisible();
  });

  test("deletes a connection from its menu, and leaves the others alone", async ({
    authedPage: page,
    apiClient,
  }) => {
    const label = `Gateway ${Date.now()}`;
    const { keyLabel } = await seedGateway(apiClient, label);
    const anthropic = await apiClient.post("/model-provider-credentials", {
      providerId: "anthropic",
      api_key: "sk-ant-e2e",
    });
    expect(anthropic.status()).toBe(201);
    const other = (await anthropic.json()) as { id: string; config_id: string };
    const model = await apiClient.post("/models", {
      modelId: MODEL_ID,
      config_id: other.config_id,
    });
    expect(model.status()).toBe(201);

    const row = await openConfig(page, label);
    await row.getByRole("button", { name: `Actions de la connexion « ${keyLabel} »` }).click();
    await page.getByRole("menuitem", { name: DELETE }).click();
    const dialog = page.getByRole("alertdialog", { name: "Supprimer la connexion ?" });
    await expect(dialog.getByText(`Supprimer la connexion « ${keyLabel} » ?`)).toBeVisible();
    await dialog.getByRole("button", { name: DELETE, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByTitle(keyLabel, { exact: true })).toHaveCount(0);
    await expect(row.getByText("À connecter", { exact: true })).toBeVisible();

    const keys = (await (await apiClient.get("/model-provider-credentials")).json()).data as Array<{
      id: string;
    }>;
    expect(keys.find((k) => k.id === other.id)).toBeDefined();
  });

  test("deletes a configuration with its connections", async ({ authedPage: page, apiClient }) => {
    const label = `Gateway ${Date.now()}`;
    const { configId, keyId } = await seedGateway(apiClient, label);

    await page.goto(MODELS_SETTINGS_PATH);
    const row = configRow(page, label);
    await row.getByRole("button", { name: `Actions de « ${label} »` }).click();
    await page.getByRole("menuitem", { name: DELETE }).click();
    const dialog = page.getByRole("alertdialog", { name: "Supprimer la configuration ?" });
    await dialog.getByRole("button", { name: DELETE, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(configRow(page, label)).toHaveCount(0);

    const configs = (await (await apiClient.get("/model-configs")).json()).data as Array<{
      id: string;
    }>;
    expect(configs.find((c) => c.id === configId)).toBeUndefined();
    const keys = (await (await apiClient.get("/model-provider-credentials")).json()).data as Array<{
      id: string;
    }>;
    expect(keys.find((k) => k.id === keyId)).toBeUndefined();
  });
});
