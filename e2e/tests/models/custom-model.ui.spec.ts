// SPDX-License-Identifier: Apache-2.0

/**
 * Adding a model on a custom endpoint from org settings → Modèles, against a
 * mock endpoint this spec serves itself.
 *
 * The picker offers one "Endpoint personnalisé" row for every base-URL-
 * overridable registry entry; which of them it is becomes the "Type d'API"
 * question inside the form. Both shapes it can speak are exercised here —
 * OpenAI (`GET <baseUrl>/models`, `Authorization: Bearer`) and Anthropic
 * (`GET <baseUrl>/v1/models`, `x-api-key`), which is why the two tests type a
 * different base URL against the same mock.
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
const OPENAI_MODELS = ["gpt-4o", "qwen3:8b"];
const ANTHROPIC_MODELS = [{ id: "claude-x", display_name: "Claude X" }];
/** The form modal's title, identical to the button that opens it (`models.add` / `models.form.title`). */
const ADD_MODEL = "Ajouter un modèle";
/** The single picker row every overridable endpoint collapses into (`models.form.customEndpoint`). */
const CUSTOM_ENDPOINT = "Endpoint personnalisé";
/** The discovery combobox shows this placeholder until a model is picked. */
const MODEL_SEARCH_PLACEHOLDER = "Rechercher parmi les modèles détectés...";

let server: Server;
/** Mock origin without a path — each test appends what its API shape expects. */
let mockOrigin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // One path, two wire formats: the platform appends `/models` to an
    // OpenAI-shaped base URL (typed with `/v1`) and `/v1/models` to an
    // Anthropic-shaped one (typed without), so the auth header is what tells
    // the two callers apart.
    if (req.headers.authorization === `Bearer ${GOOD_KEY}`) {
      json(200, { data: OPENAI_MODELS.map((id) => ({ id })) });
      return;
    }
    if (req.headers["x-api-key"] === GOOD_KEY) {
      json(200, { data: ANTHROPIC_MODELS });
      return;
    }
    json(401, { error: { message: "bad key" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server has no port");
  mockOrigin = `http://127.0.0.1:${address.port}`;
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

/**
 * Open the model form on the custom-endpoint path and answer step 1: which
 * API shape, where it lives, and the key that opens it. `apiType` left out
 * keeps the pre-selected first overridable entry (OpenAI-compatible).
 */
async function openCustomEndpointForm(
  page: Page,
  { baseUrl, apiKey, apiType }: { baseUrl: string; apiKey: string; apiType?: string },
) {
  await page.goto(SETTINGS_PATH);
  // Header button and empty-state button carry the same label; either opens the form.
  await page.getByRole("button", { name: ADD_MODEL }).first().click();
  // Named, because the discovery combobox's popover is a `dialog` too.
  await expect(page.getByRole("dialog", { name: ADD_MODEL })).toBeVisible();

  await selectOption(page, "mdl-provider", CUSTOM_ENDPOINT);
  if (apiType) await selectOption(page, "mdl-apiType", apiType);
  await page.locator("#mdl-baseUrl").fill(baseUrl);
  await page.getByPlaceholder("sk-...").fill(apiKey);
}

test.describe("Custom endpoint model — UI", () => {
  test("discovers an OpenAI-shaped endpoint's models and saves the picked one", async ({
    authedPage: page,
    apiClient,
  }) => {
    const baseUrl = `${mockOrigin}/v1`;
    await openCustomEndpointForm(page, { baseUrl, apiKey: GOOD_KEY });

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

    // "Avancé" is folded away by default but a discovered pick unfolds it —
    // it just filled the capabilities in, so clicking would close it.
    await expect(page.getByRole("button", { name: "Avancé" })).toBeVisible();
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
      baseUrl,
    });
  });

  test("reports a key the endpoint rejects", async ({ authedPage: page }) => {
    await openCustomEndpointForm(page, { baseUrl: `${mockOrigin}/v1`, apiKey: "e2e-wrong-key" });

    await page.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(page.getByText("Clé refusée par le endpoint.")).toBeVisible();
  });

  test("saves a manually typed model id and lets the server name the row", async ({
    authedPage: page,
    apiClient,
  }) => {
    await openCustomEndpointForm(page, { baseUrl: `${mockOrigin}/v1`, apiKey: GOOD_KEY });

    await page.getByRole("button", { name: "Configurer manuellement" }).click();
    await page.locator("#mdl-modelId").fill("llama3");
    // Name left empty on purpose: the server derives it from the model id.
    await page.getByRole("button", { name: "Enregistrer" }).click();

    await expect(page.getByRole("dialog", { name: ADD_MODEL })).toBeHidden();
    await expect(page.getByText("llama3").first()).toBeVisible();

    const res = await apiClient.get("/models");
    const body = await res.json();
    const created = (body.data as Array<Record<string, unknown>>).find(
      (m) => m.modelId === "llama3",
    );
    expect(created).toMatchObject({ modelId: "llama3", label: "llama3" });
  });

  test("discovers an Anthropic-shaped endpoint's models", async ({
    authedPage: page,
    apiClient,
  }) => {
    // No `/v1`: the platform appends `/v1/models` for this shape.
    await openCustomEndpointForm(page, {
      baseUrl: mockOrigin,
      apiKey: GOOD_KEY,
      apiType: "Anthropic-compatible (custom)",
    });

    await page.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(page.getByText("1 modèle détecté")).toBeVisible();

    await page.getByRole("combobox").filter({ hasText: MODEL_SEARCH_PLACEHOLDER }).click();
    // The discovery endpoint names each row from the pricing catalog, which
    // does not know `claude-x` — so the row reads as its id.
    await page.getByRole("option", { name: /claude-x/ }).click();
    await page.getByRole("button", { name: "Enregistrer" }).click();

    await expect(page.getByRole("dialog", { name: ADD_MODEL })).toBeHidden();

    const res = await apiClient.get("/models");
    const body = await res.json();
    const created = (body.data as Array<Record<string, unknown>>).find(
      (m) => m.modelId === "claude-x",
    );
    expect(created).toMatchObject({ modelId: "claude-x", apiShape: "anthropic-messages" });
  });
});
