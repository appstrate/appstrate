// SPDX-License-Identifier: Apache-2.0

/**
 * Adding an OpenAI-compatible (custom) model from org settings → Modèles,
 * against a mock endpoint this spec serves itself.
 *
 * The mock is a `node:http` server on 127.0.0.1 — Playwright runs under
 * Node, and a loopback endpoint is the only way to exercise discovery
 * without a real provider key. The platform's SSRF guard refuses loopback
 * unless the operator trusts it, so `playwright.config.ts` pins
 * `EGRESS_ALLOW_INTERNAL_HOSTS` for the API it launches.
 *
 * @tags @smoke
 */

import { createServer, type Server } from "node:http";
import { test, expect } from "../../fixtures/browser.fixture.ts";
import type { Page } from "@playwright/test";

const SETTINGS_PATH = "/org-settings/models";
const GOOD_KEY = "e2e-good-key";
const SERVED_MODELS = ["gpt-4o", "qwen3:8b"];
/** The form modal's title, identical to the button that opens it (`models.add` / `models.form.title`). */
const ADD_MODEL = "Ajouter un modèle";
/** The discovery combobox shows this placeholder until a model is picked. */
const MODEL_SEARCH_PLACEHOLDER = "Rechercher parmi les modèles détectés...";

let server: Server;
let mockBaseUrl: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: SERVED_MODELS.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server has no port");
  mockBaseUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

/**
 * Pick an option in a Radix select, which renders a listbox rather than a
 * `<select>`. The popper list is taller than the browser viewport and does not
 * scroll with the page, so an option far down it is unclickable; its typeahead
 * brings the option under the cursor and Enter commits it.
 */
async function selectOption(page: Page, triggerId: string, optionName: string) {
  const trigger = page.locator(`#${triggerId}`);
  const option = page.getByRole("option", { name: optionName, exact: true });
  await trigger.click();
  // The list must be mounted before typing, or the keystrokes go nowhere and
  // Enter commits whatever happens to be highlighted first.
  await expect(option).toBeVisible();
  await page.keyboard.type(optionName.split(" ")[0]!);
  await expect(option).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText(optionName);
}

/** Open the model form on the custom-provider path, with the endpoint + key filled in. */
async function openCustomProviderForm(page: Page, apiKey: string) {
  await page.goto(SETTINGS_PATH);
  // Header button and empty-state button carry the same label; either opens the form.
  await page.getByRole("button", { name: ADD_MODEL }).first().click();
  // Named, because the discovery combobox's popover is a `dialog` too.
  await expect(page.getByRole("dialog", { name: ADD_MODEL })).toBeVisible();

  await selectOption(page, "mdl-provider", "OpenAI-compatible (custom)");
  await page.locator("#mdl-baseUrl").fill(mockBaseUrl);
  await page.getByPlaceholder("sk-...").fill(apiKey);
}

test.describe("Custom (OpenAI-compatible) model — UI", () => {
  test("discovers the endpoint's models and saves the picked one", async ({
    authedPage: page,
    apiClient,
  }) => {
    await openCustomProviderForm(page, GOOD_KEY);

    await page.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(page.getByText("2 modèles détectés")).toBeVisible();

    // Discovery replaces the model-id input with a searchable combobox. The
    // `combobox` role forbids name-from-content, so it has no accessible name
    // at all and has to be told apart by its text. Each row renders the catalog
    // label over the raw id — `gpt-4o` is catalog-known ("Gpt 4o") and
    // `qwen3:8b` is not, so match rows on the id.
    await page.getByRole("combobox").filter({ hasText: MODEL_SEARCH_PLACEHOLDER }).click();
    await expect(page.getByRole("option", { name: /gpt-4o/ })).toBeVisible();
    await page.getByRole("option", { name: /qwen3:8b/ }).click();
    await expect(page.locator("#mdl-label")).toHaveValue("qwen3:8b");

    await page.locator("#mdl-ctx").fill("32768");
    await page.getByRole("button", { name: "Enregistrer" }).click();

    await expect(page.getByRole("dialog", { name: ADD_MODEL })).toBeHidden();
    await expect(page.getByText("qwen3:8b").first()).toBeVisible();

    const res = await apiClient.get("/models");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const created = (body.data as Array<Record<string, unknown>>).find(
      (m) => m.modelId === "qwen3:8b",
    );
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      label: "qwen3:8b",
      modelId: "qwen3:8b",
      contextWindow: 32768,
      apiShape: "openai-completions",
      baseUrl: mockBaseUrl,
    });
  });

  test("reports a key the endpoint rejects", async ({ authedPage: page }) => {
    await openCustomProviderForm(page, "e2e-wrong-key");

    await page.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(page.getByText("Clé refusée par le endpoint.")).toBeVisible();
  });
});
