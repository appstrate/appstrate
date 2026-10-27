// SPDX-License-Identifier: Apache-2.0

/**
 * Driving Settings › Models: the « Ajouter une clé org » flow and the rows of
 * the « Clés org » table, shared by the specs that add keys and models.
 *
 * A key is added in two steps inside one dialog: the key itself (provider, name,
 * secret, and for a custom endpoint its API type and base URL), then the models
 * that key makes available. Nothing is written until the second step's button.
 */

import { expect, type Locator, type Page } from "@playwright/test";
import type { ApiClient } from "./api-client.ts";

export const MODELS_SETTINGS_PATH = "/org-settings/models";
/** The dialog's title and its last button (`credentials.add`). */
const ADD_KEY = "Ajouter une clé org";
/** The first step's button (`credentials.form.next`). */
export const NEXT = "Suivant";

/** Open Settings › Models, then the Actions menu's « Ajouter une clé org »; resolves to the dialog. */
export async function openAddKeyDialog(page: Page): Promise<Locator> {
  await page.goto(MODELS_SETTINGS_PATH);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: ADD_KEY }).click();
  // Named, because a Radix select's popper is a `dialog` too.
  const dialog = page.getByRole("dialog", { name: ADD_KEY });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The checkbox of one model in the list, matched on its id (a substring of its accessible name). */
export function modelRow(dialog: Locator, modelId: string): Locator {
  return dialog.getByRole("checkbox", { name: new RegExp(`${modelId}$`) });
}

/** The footer button that writes everything: the same label as the dialog's title. */
export function submitAddKey(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: ADD_KEY, exact: true });
}

/** The org's models, as `GET /api/models` resolves them. */
export async function listModels(
  apiClient: Pick<ApiClient, "get">,
): Promise<Array<Record<string, unknown>>> {
  const res = await apiClient.get("/models");
  expect(res.status()).toBe(200);
  return (await res.json()).data as Array<Record<string, unknown>>;
}
