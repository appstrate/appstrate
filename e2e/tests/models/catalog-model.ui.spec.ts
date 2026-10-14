// SPDX-License-Identifier: Apache-2.0

/**
 * Adding a catalogued provider's key and model from org settings → Modèles, and
 * then renaming the model.
 *
 * A pinned provider is the half of the model form that touches no network at
 * all: its endpoint is not the operator's to describe, and the models it offers
 * come from the model catalog (Pi's registry) the platform already ships. So this
 * spec never stands up a mock endpoint — the key it types is never used for
 * anything but creating a credential row.
 *
 * The rename is the interesting half. `GET /api/models` returns RESOLVED
 * values, so the edit form opens on the catalog's own context window and max
 * output; if it read those as the operator's answers it would write them back
 * as overrides, and the row would silently stop following the catalog. The
 * intercepted request body is where that is either true or false.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { selectOption } from "../../helpers/radix.ts";
import { openRowMenuItem } from "../../helpers/table.ts";
import {
  NEXT,
  listModels,
  modelRow,
  openAddKeyDialog,
  submitAddKey,
} from "../../helpers/models.ts";
import type { APIResponse, Locator, Page } from "@playwright/test";

const EDIT_MODEL = "Modifier le modèle";
const PROVIDER = "Anthropic";

/**
 * Two ids the catalog carries for Anthropic — one to add, one that must
 * disappear when the list is searched. Both come from the catalog itself, so
 * no request describes them.
 */
const MODEL_ID = "claude-sonnet-4-5-20250929";
/** Unique as a substring, so the row locator matches exactly one checkbox. */
const OTHER_MODEL_ID = "claude-opus-4-7";

const NEW_LABEL = "Sonnet de l'équipe";

/** The four the capabilities toggle owns — an "auto" row sends none of them. */
const CATALOG_DERIVABLE = ["input", "contextWindow", "maxTokens", "reasoning"] as const;

/**
 * The catalog's own entry for {@link MODEL_ID}, read from the registry the
 * form reads — never restated, since the assertion is "the row follows it".
 */
async function catalogEntry(apiClient: {
  get(path: string): Promise<APIResponse>;
}): Promise<{ label: string; contextWindow: number }> {
  const res = await apiClient.get("/model-provider-credentials/registry");
  expect(res.status()).toBe(200);
  const providers = (await res.json()).data as Array<{
    providerId: string;
    models: Array<{ id: string; label: string; contextWindow: number }>;
  }>;
  const entry = providers
    .find((p) => p.providerId === "anthropic")
    ?.models.find((m) => m.id === MODEL_ID);
  expect(entry).toBeDefined();
  return entry!;
}

/** Open the flow and answer step 1: the provider, and the key to open it with; lands on the model list. */
async function addCatalogKey(page: Page): Promise<Locator> {
  const dialog = await openAddKeyDialog(page);

  await selectOption(page, "pk-provider", PROVIDER);
  // A pinned provider answers for its own endpoint: no API type, no base URL.
  await expect(dialog.locator("#pk-apiType")).toHaveCount(0);
  await expect(dialog.locator("#pk-baseUrl")).toHaveCount(0);

  await dialog.getByPlaceholder("sk-...").fill("sk-e2e");
  await dialog.getByRole("button", { name: NEXT, exact: true }).click();
  // The catalog is free to read, so the list is there as soon as the key is
  // typed — nothing to detect, and every model starts ticked.
  await expect(dialog.locator("#mdl-modelSearch")).toBeVisible();
  return dialog;
}

/** Add the key with exactly {@link MODEL_ID} ticked, and wait for the dialog to close. */
async function addKeyWithOneModel(page: Page): Promise<void> {
  const dialog = await addCatalogKey(page);
  await dialog.getByRole("checkbox", { name: "Tout sélectionner" }).click();
  await modelRow(dialog, MODEL_ID).click();
  await expect(modelRow(dialog, MODEL_ID)).toBeChecked();
  await submitAddKey(dialog).click();
  await expect(dialog).toBeHidden();
}

/** From the key's row, open the model list, then the saved model's « Réglages avancés ». */
async function openModelSettings(page: Page): Promise<Locator> {
  await openRowMenuItem(page, PROVIDER, "Choisir les modèles");
  await page.getByRole("button", { name: "Réglages avancés" }).click();
  const dialog = page.getByRole("dialog", { name: EDIT_MODEL });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Catalogued model — UI", () => {
  test("offers the provider's catalog, narrows it, and adds the checked model", async ({
    authedPage: page,
    apiClient,
  }) => {
    const { label } = await catalogEntry(apiClient);
    const dialog = await addCatalogKey(page);

    await expect(modelRow(dialog, MODEL_ID)).toBeVisible();
    await expect(modelRow(dialog, OTHER_MODEL_ID)).toHaveCount(1);

    await dialog.locator("#mdl-modelSearch").fill("sonnet-4-5-2025");
    await expect(modelRow(dialog, OTHER_MODEL_ID)).toHaveCount(0);
    await expect(modelRow(dialog, MODEL_ID)).toBeVisible();

    // A new key starts with the whole catalog ticked: leave only the one.
    await dialog.locator("#mdl-modelSearch").fill("");
    await dialog.getByRole("checkbox", { name: "Tout sélectionner" }).click();
    await expect(modelRow(dialog, MODEL_ID)).not.toBeChecked();
    await modelRow(dialog, MODEL_ID).click();
    await expect(modelRow(dialog, MODEL_ID)).toBeChecked();
    await submitAddKey(dialog).click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("row").filter({ hasText: PROVIDER }).getByText(label),
    ).toBeVisible();

    const models = await listModels(apiClient);
    const created = models.find((m) => m.modelId === MODEL_ID);
    // The row was created from the id alone: its name and every capability were
    // resolved server-side from the catalog it names.
    expect(created).toMatchObject({
      modelId: MODEL_ID,
      label,
      providerId: "anthropic",
      apiShape: "anthropic-messages",
    });
    // Only the ticked model was written, not the catalog it came from.
    expect(models.filter((m) => m.source !== "built-in")).toHaveLength(1);
  });

  test("renames a catalogued row without freezing its catalog values", async ({
    authedPage: page,
    apiClient,
  }) => {
    const { contextWindow } = await catalogEntry(apiClient);
    await addKeyWithOneModel(page);

    const dialog = await openModelSettings(page);

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
      (req) => req.method() === "PATCH" && /\/api\/models\/[^/]+$/.test(req.url()),
    );
    await dialog.getByRole("button", { name: "Enregistrer" }).click();

    const body = JSON.parse((await saved).postData() ?? "{}") as Record<string, unknown>;
    expect(body.label).toBe(NEW_LABEL);
    // `null` clears an override and is a no-op for a row that never had one; a
    // real number here would be the catalog's own value written back as the
    // operator's, cutting the row off from the catalog.
    for (const field of CATALOG_DERIVABLE) expect(body[field] ?? null).toBeNull();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("row").filter({ hasText: PROVIDER }).getByText(NEW_LABEL),
    ).toBeVisible();
    const renamed = (await listModels(apiClient)).find((m) => m.modelId === MODEL_ID);
    expect(renamed).toMatchObject({ label: NEW_LABEL, contextWindow });
  });

  test("answers for one capability without freezing the three it did not touch", async ({
    authedPage: page,
    apiClient,
  }) => {
    const { contextWindow } = await catalogEntry(apiClient);
    await addKeyWithOneModel(page);

    const dialog = await openModelSettings(page);

    // Taking the capabilities on prefills the four with what `GET /api/models`
    // resolved — the catalog's own numbers. Untick "Image" and nothing else.
    await dialog.locator("#mdl-capabilities-explicit").click();
    await expect(dialog.locator("#mdl-ctx")).toHaveValue(String(contextWindow));
    await dialog.locator("#mdl-input-image").click();

    const saved = page.waitForRequest(
      (req) => req.method() === "PATCH" && /\/api\/models\/[^/]+$/.test(req.url()),
    );
    await dialog.getByRole("button", { name: "Enregistrer" }).click();

    const body = JSON.parse((await saved).postData() ?? "{}") as Record<string, unknown>;
    // The one answer the operator gave — and nothing else. A number here would
    // be the catalog's own value written back as an override, cutting the row
    // off from the catalog over an edit about modalities.
    expect(body.input).toEqual(["text"]);
    for (const field of ["contextWindow", "maxTokens", "reasoning"] as const) {
      expect(body[field] ?? null).toBeNull();
    }
    await expect(dialog).toBeHidden();
  });
});
