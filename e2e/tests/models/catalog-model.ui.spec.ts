// SPDX-License-Identifier: Apache-2.0

/**
 * Adding a catalogued provider's model from org settings → Modèles, and then
 * renaming it.
 *
 * A pinned provider is the half of the model form that touches no network at
 * all: its endpoint is not the operator's to describe, and the models it offers
 * come from the vendored pricing catalog the platform already ships. So this
 * spec never stands up a mock endpoint — the key it types is never used for
 * anything but creating a credential row.
 *
 * The rename is the interesting half. `GET /api/models` returns RESOLVED
 * values, so the edit form opens on the catalog's own context window and max
 * output; if it read those as the operator's answers it would write them back
 * as overrides, and the row would silently stop following the weekly catalog
 * refresh. The intercepted request body is where that is either true or false.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { selectOption } from "../../helpers/radix.ts";
import type { APIResponse, Locator, Page } from "@playwright/test";

const SETTINGS_PATH = "/org-settings/models";
/** The form modal's title, identical to the button that opens it. */
const ADD_MODEL = "Ajouter un modèle";
const EDIT_MODEL = "Modifier le modèle";
const PROVIDER = "Anthropic";

/**
 * Two ids the vendored catalog carries for Anthropic — one to add, one that
 * must disappear when the list is searched. Both come from the catalog itself
 * (`apps/api/src/data/`), so no request describes them.
 */
const MODEL_ID = "claude-sonnet-4-5-20250929";
/** The catalog's own label for it, which the server derives the row's name from. */
const MODEL_LABEL = "Claude Sonnet 4 5 20250929";
/** Unique as a substring, so the row locator matches exactly one checkbox. */
const OTHER_MODEL_ID = "claude-3-opus-20240229";

const NEW_LABEL = "Sonnet de l'équipe";

/** The four the capabilities toggle owns — an "auto" row sends none of them. */
const CATALOG_DERIVABLE = ["input", "contextWindow", "maxTokens", "reasoning"] as const;

function pickRow(dialog: Locator, modelId: string): Locator {
  return dialog.getByRole("checkbox", { name: new RegExp(modelId) });
}

async function listModels(apiClient: {
  get(path: string): Promise<APIResponse>;
}): Promise<Array<Record<string, unknown>>> {
  const res = await apiClient.get("/models");
  expect(res.status()).toBe(200);
  return (await res.json()).data as Array<Record<string, unknown>>;
}

/** Open the form and answer step 1: the provider, and a key to open it with. */
async function addCatalogModel(page: Page): Promise<Locator> {
  await page.goto(SETTINGS_PATH);
  // Header button and empty-state button carry the same label; either opens it.
  await page.getByRole("button", { name: ADD_MODEL }).first().click();
  // Named, because a Radix select's popper is a `dialog` too.
  const dialog = page.getByRole("dialog", { name: ADD_MODEL });
  await expect(dialog).toBeVisible();

  await selectOption(page, "mdl-provider", PROVIDER);
  // A pinned provider answers for its own endpoint: no API type, no base URL.
  await expect(dialog.locator("#mdl-apiType")).toHaveCount(0);
  await expect(dialog.locator("#mdl-baseUrl")).toHaveCount(0);

  await dialog.getByPlaceholder("sk-...").fill("sk-e2e");
  return dialog;
}

test.describe("Catalogued model — UI", () => {
  test("offers the provider's catalog, narrows it, and adds the checked model", async ({
    authedPage: page,
    apiClient,
  }) => {
    const dialog = await addCatalogModel(page);

    // The catalog is free to read, so the list is there as soon as the endpoint
    // is open — nothing to detect, nothing to click first.
    await expect(dialog.locator("#mdl-modelSearch")).toBeVisible();
    await expect(pickRow(dialog, MODEL_ID)).toBeVisible();
    await expect(pickRow(dialog, OTHER_MODEL_ID)).toHaveCount(1);

    await dialog.locator("#mdl-modelSearch").fill("sonnet-4-5-2025");
    await expect(pickRow(dialog, OTHER_MODEL_ID)).toHaveCount(0);
    await expect(pickRow(dialog, MODEL_ID)).toBeVisible();

    await pickRow(dialog, MODEL_ID).click();
    await expect(pickRow(dialog, MODEL_ID)).toBeChecked();
    await dialog.getByRole("button", { name: "Ajouter 1 modèle", exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(MODEL_LABEL).first()).toBeVisible();

    const created = (await listModels(apiClient)).find((m) => m.modelId === MODEL_ID);
    // The row was created from the id alone: its name and every capability were
    // resolved server-side from the catalog it names.
    expect(created).toMatchObject({
      modelId: MODEL_ID,
      label: MODEL_LABEL,
      providerId: "anthropic",
      apiShape: "anthropic-messages",
    });
  });

  test("renames a catalogued row without freezing its catalog values", async ({
    authedPage: page,
    apiClient,
  }) => {
    const addDialog = await addCatalogModel(page);
    await pickRow(addDialog, MODEL_ID).click();
    await addDialog.getByRole("button", { name: "Ajouter 1 modèle", exact: true }).click();
    await expect(addDialog).toBeHidden();

    await page.getByRole("button", { name: "Modifier", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: EDIT_MODEL });
    await expect(dialog).toBeVisible();

    // The endpoint belongs to the saved row: the provider is locked, and the
    // key it runs on is shown as a chip rather than asked for again.
    await expect(dialog.locator("#mdl-provider")).toBeDisabled();
    await expect(dialog.getByPlaceholder("sk-...")).toHaveCount(0);
    await expect(dialog.locator("#mdl-modelId")).toHaveValue(MODEL_ID);
    // The row's numbers ARE the catalog's, so it has overridden nothing: the
    // capabilities toggle stays off and states the fallback chain instead.
    await expect(dialog.locator("#mdl-ctx")).toHaveCount(0);

    await dialog.locator("#mdl-label").fill(NEW_LABEL);
    const saved = page.waitForRequest(
      (req) => req.method() === "PUT" && /\/api\/models\/[^/]+$/.test(req.url()),
    );
    await dialog.getByRole("button", { name: "Enregistrer" }).click();

    const body = JSON.parse((await saved).postData() ?? "{}") as Record<string, unknown>;
    expect(body.label).toBe(NEW_LABEL);
    // `null` clears an override and is a no-op for a row that never had one; a
    // real number here would be the catalog's own value written back as the
    // operator's, cutting the row off from the weekly refresh.
    for (const field of CATALOG_DERIVABLE) expect(body[field] ?? null).toBeNull();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(NEW_LABEL).first()).toBeVisible();
    const renamed = (await listModels(apiClient)).find((m) => m.modelId === MODEL_ID);
    expect(renamed).toMatchObject({ label: NEW_LABEL, contextWindow: 200000 });
  });
});
