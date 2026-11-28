// SPDX-License-Identifier: Apache-2.0

/**
 * Driving Settings › Models: the « Ajouter une configuration » flow and the rows of the
 * configurations, shared by the specs that add configurations and models.
 *
 * The flow is three dialogs in a row: the service (and a gateway's API type and base URL), then
 * « Choisir les modèles de « … » », then « Connecter « … » », the organization's key. The
 * configuration is written by the first, the models by the second, the key by the third.
 */

import { expect, type Locator, type Page } from "@playwright/test";
import type { ApiClient } from "./api-client.ts";
import { selectOption } from "./select.ts";

export const MODELS_SETTINGS_PATH = "/org-settings/models";
/** The page action and the first dialog's title (`modelConfigs.add.*`). */
const ADD_CONFIG = "Ajouter une configuration";
/** The first dialog's button (`modelConfigs.add.submit`). */
const NEXT = "Suivant";
/** The model list's and the key form's button (`btn.save`). */
export const SAVE = "Enregistrer";

/**
 * Open Settings › Models, then « Ajouter une configuration », pick the service (and, for a
 * gateway, answer its endpoint), and go on; resolves to « Choisir les modèles ».
 */
export async function addConfiguration(
  page: Page,
  service: string,
  endpoint?: { apiType: string; baseUrl: string },
): Promise<Locator> {
  await page.goto(MODELS_SETTINGS_PATH);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: ADD_CONFIG }).click();
  // Named, because the settings overlay around it is a `dialog` too.
  const dialog = page.getByRole("dialog", { name: ADD_CONFIG });
  await expect(dialog).toBeVisible();

  await selectOption(page, "cfg-provider", service);
  if (endpoint) {
    await selectOption(page, "cfg-apiType", endpoint.apiType);
    await dialog.locator("#cfg-baseUrl").fill(endpoint.baseUrl);
  } else {
    // A pinned provider answers for its own endpoint: no API type, no base URL.
    await expect(dialog.locator("#cfg-apiType")).toHaveCount(0);
    await expect(dialog.locator("#cfg-baseUrl")).toHaveCount(0);
  }
  await dialog.getByRole("button", { name: NEXT, exact: true }).click();
  await expect(dialog).toBeHidden();
  return modelChoiceDialog(page);
}

/** « Choisir les modèles de « … » », whichever configuration it is for. */
export function modelChoiceDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: /^Choisir les modèles de « / });
}

/** « Connecter « … » », the step that follows the models of a new configuration. */
export function connectDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: /^Connecter « / });
}

/** The checkbox of one model in the list, matched on its id (a substring of its accessible name). */
export function modelRow(dialog: Locator, modelId: string): Locator {
  return dialog.getByRole("checkbox", { name: new RegExp(`${modelId}$`) });
}

/** Leave exactly `modelId` ticked, whatever the list started with. */
export async function tickOnly(dialog: Locator, modelId: string): Promise<void> {
  const all = dialog.getByRole("checkbox", { name: "Tout sélectionner" });
  if (!(await all.isChecked())) await all.click();
  await all.click();
  await expect(all).not.toBeChecked();
  await modelRow(dialog, modelId).click();
  await expect(modelRow(dialog, modelId)).toBeChecked();
}

/**
 * A configuration's row on the page, found by its label through its open/fold toggle: the label
 * alone can also be a connection's, a row nested in the open configuration.
 */
export function configRow(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator("[data-row]").filter({
    has: page.getByRole("button", { name: new RegExp(`^(Ouvrir|Replier) « ${escaped} »$`) }),
  });
}

/** The org's models, as `GET /api/models` resolves them. */
export async function listModels(
  apiClient: Pick<ApiClient, "get">,
): Promise<Array<Record<string, unknown>>> {
  const res = await apiClient.get("/models");
  expect(res.status()).toBe(200);
  return (await res.json()).data as Array<Record<string, unknown>>;
}
