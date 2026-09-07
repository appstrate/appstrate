// SPDX-License-Identifier: Apache-2.0

/**
 * Adding models on a custom endpoint from org settings → Modèles, against a
 * mock endpoint this spec serves itself.
 *
 * The picker offers one "Endpoint personnalisé" row for every base-URL-
 * overridable registry entry; which of them it is becomes the "Type d'API"
 * question inside the form. Both shapes it can speak are exercised here —
 * OpenAI (`GET <baseUrl>/models`, `Authorization: Bearer`) and Anthropic
 * (`GET <baseUrl>/v1/models`, `x-api-key`), which is why the two tests type a
 * different base URL against the same mock.
 *
 * One detection describes every model the endpoint serves, so the form adds
 * them as a batch: the listing is a checkbox list and the footer button counts
 * what is checked. That makes three things worth asserting beyond "a model was
 * saved" — adding several at once, a batch the server only partly accepts, and
 * a detection run against a key the org already saved.
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
import { selectOption } from "../../helpers/radix.ts";
import type { APIResponse, Locator, Page } from "@playwright/test";

const SETTINGS_PATH = "/org-settings/models";
const GOOD_KEY = "e2e-good-key";
/** The form modal's title, identical to the button that opens it (`models.add` / `models.form.title`). */
const ADD_MODEL = "Ajouter un modèle";
/** The single picker row every overridable endpoint collapses into (`models.form.customEndpoint`). */
const CUSTOM_ENDPOINT = "Endpoint personnalisé";
/** Registry display names of the two custom-endpoint entries, the "Type d'API" options. */
const OPENAI_TYPE = "OpenAI-compatible (custom)";
const ANTHROPIC_TYPE = "Anthropic-compatible (custom)";
/** The provider id behind {@link OPENAI_TYPE}, for a credential seeded over the API. */
const OPENAI_PROVIDER_ID = "openai-compatible";

/**
 * What the default path serves. `gpt-4o` is described by the vendored catalog
 * and `qwen3:8b` by the listing itself (`context_length`) — between them every
 * row provenance the list can show.
 */
const CATALOG_MODEL = "gpt-4o";
const SERVED_MODEL = "qwen3:8b";
const SERVED_CONTEXT = 32768;
const ANTHROPIC_MODEL = "claude-x";

/**
 * A second OpenAI-shaped path, serving one model the platform accepts and one
 * it must refuse: `POST /api/models` rejects `maxTokens >= contextWindow`
 * (createModelSchema's canonical budget invariant), and both numbers come
 * straight from what the endpoint published. Nothing else about a discovered
 * model is refusable — two identical models are NOT a conflict (`org_models`
 * carries no uniqueness on `(org, model_id)`), so a duplicate cannot stand in
 * for a partial failure.
 */
const SPLIT_PATH = "/split/v1";
const ADDABLE_MODEL = "local-small";
const REFUSED_MODEL = "local-overflow";

let server: Server;
/** Mock origin without a path — each test appends what its API shape expects. */
let mockOrigin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // One host, two wire formats: the platform appends `/models` to an
    // OpenAI-shaped base URL (typed with `/v1`) and `/v1/models` to an
    // Anthropic-shaped one (typed without), so the auth header is what tells
    // the two callers apart. The path only picks which listing to answer with.
    if (req.headers.authorization === `Bearer ${GOOD_KEY}`) {
      json(200, {
        data: (req.url ?? "").startsWith(SPLIT_PATH)
          ? [
              { id: ADDABLE_MODEL },
              { id: REFUSED_MODEL, context_length: 4096, max_output_tokens: 8192 },
            ]
          : [{ id: CATALOG_MODEL }, { id: SERVED_MODEL, context_length: SERVED_CONTEXT }],
      });
      return;
    }
    if (req.headers["x-api-key"] === GOOD_KEY) {
      json(200, { data: [{ id: ANTHROPIC_MODEL }] });
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
 * Open the model form on the custom-endpoint path and answer step 1: which API
 * shape, where it lives, and the key that opens it. The shape is always picked
 * explicitly: the pre-selected entry is whichever the registry lists first,
 * which is not something a test should depend on. `baseUrl`/`apiKey` are
 * omitted by the one test that answers both by picking a saved key instead.
 */
async function openCustomEndpointForm(
  page: Page,
  { baseUrl, apiKey, apiType }: { baseUrl?: string; apiKey?: string; apiType: string },
): Promise<Locator> {
  await page.goto(SETTINGS_PATH);
  // Header button and empty-state button carry the same label; either opens the form.
  await page.getByRole("button", { name: ADD_MODEL }).first().click();
  // Named, because a Radix select's popper is a `dialog` too.
  const dialog = page.getByRole("dialog", { name: ADD_MODEL });
  await expect(dialog).toBeVisible();

  await selectOption(page, "mdl-provider", CUSTOM_ENDPOINT);
  await selectOption(page, "mdl-apiType", apiType);
  if (baseUrl !== undefined) await dialog.locator("#mdl-baseUrl").fill(baseUrl);
  if (apiKey !== undefined) await dialog.getByPlaceholder("sk-...").fill(apiKey);
  return dialog;
}

/**
 * One row of the model pick list. The row is a Radix checkbox (a `button`)
 * labelled by the model's name over its raw id, so the id is a substring of the
 * accessible name whether or not the catalog named the model.
 */
function discoveredRow(dialog: Locator, modelId: string): Locator {
  return dialog.getByRole("checkbox", { name: modelId });
}

/** The footer button while the list is shown — i18n plural (`models.form.addModels`). */
function addModelsButton(dialog: Locator, count: number): Locator {
  return dialog.getByRole("button", {
    name: count === 1 ? "Ajouter 1 modèle" : `Ajouter ${count} modèles`,
    exact: true,
  });
}

async function listModels(apiClient: {
  get(path: string): Promise<APIResponse>;
}): Promise<Array<Record<string, unknown>>> {
  const res = await apiClient.get("/models");
  expect(res.status()).toBe(200);
  return (await res.json()).data as Array<Record<string, unknown>>;
}

test.describe("Custom endpoint model — UI", () => {
  test("discovers an OpenAI-shaped endpoint's models and saves the checked one", async ({
    authedPage: page,
    apiClient,
  }) => {
    const baseUrl = `${mockOrigin}/v1`;
    const dialog = await openCustomEndpointForm(page, {
      baseUrl,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await dialog.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(dialog.getByText("2 modèles détectés")).toBeVisible();

    await discoveredRow(dialog, SERVED_MODEL).click();
    await expect(discoveredRow(dialog, SERVED_MODEL)).toBeChecked();
    await addModelsButton(dialog, 1).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(SERVED_MODEL).first()).toBeVisible();

    const created = (await listModels(apiClient)).find((m) => m.modelId === SERVED_MODEL);
    expect(created).toBeDefined();
    // Every capability is written from the listing itself — the catalog does
    // not know this id, so the context window can only be the published hint.
    expect(created).toMatchObject({
      label: SERVED_MODEL,
      modelId: SERVED_MODEL,
      contextWindow: SERVED_CONTEXT,
      apiShape: "openai-completions",
      baseUrl,
    });
  });

  test("adds every detected model in one batch", async ({ authedPage: page }) => {
    const dialog = await openCustomEndpointForm(page, {
      baseUrl: `${mockOrigin}/v1`,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await dialog.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(dialog.getByText("2 modèles détectés")).toBeVisible();

    await dialog.getByRole("checkbox", { name: "Tout sélectionner" }).click();
    await addModelsButton(dialog, 2).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(CATALOG_MODEL).first()).toBeVisible();
    await expect(page.getByText(SERVED_MODEL).first()).toBeVisible();
  });

  test("keeps the dialog open on a partly refused batch and re-offers what failed", async ({
    authedPage: page,
    apiClient,
  }) => {
    const dialog = await openCustomEndpointForm(page, {
      baseUrl: `${mockOrigin}${SPLIT_PATH}`,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await dialog.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(dialog.getByText("2 modèles détectés")).toBeVisible();

    await dialog.getByRole("checkbox", { name: "Tout sélectionner" }).click();
    const pendingRequest = Promise.withResolvers<void>();
    const releaseRequest = Promise.withResolvers<void>();
    await page.route("**/api/models", async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().postDataJSON().modelId === REFUSED_MODEL
      ) {
        pendingRequest.resolve();
        await releaseRequest.promise;
      }
      await route.continue();
    });
    await addModelsButton(dialog, 2).click();
    await pendingRequest.promise;
    try {
      // A partial result must not restore the old key into a changed endpoint.
      await expect(dialog.locator("#mdl-provider")).toBeDisabled();
      await expect(dialog.locator("#mdl-apiType")).toBeDisabled();
      await expect(dialog.locator("#mdl-baseUrl")).toBeDisabled();
      await expect(dialog.getByPlaceholder("sk-...")).toBeDisabled();
      await expect(discoveredRow(dialog, REFUSED_MODEL)).toBeDisabled();
    } finally {
      releaseRequest.resolve();
    }

    // One `POST /api/models` per checked row, each refusal collected rather
    // than aborting the rest: the accepted model is saved, the refused one is
    // named and stays checked, and the footer counts only what is left to retry.
    await expect(dialog.getByText(`Impossible d'ajouter : ${REFUSED_MODEL}`)).toBeVisible();
    await expect(discoveredRow(dialog, REFUSED_MODEL)).toBeChecked();
    await expect(discoveredRow(dialog, ADDABLE_MODEL)).not.toBeChecked();
    await expect(addModelsButton(dialog, 1)).toBeVisible();
    await expect(dialog.locator("#mdl-provider")).toBeEnabled();
    await expect(dialog.locator("#mdl-baseUrl")).toBeEnabled();

    const retryRequest = page.waitForRequest(
      (request) => request.url().endsWith("/api/models") && request.method() === "POST",
    );
    await addModelsButton(dialog, 1).click();
    const retry = await retryRequest;
    const credentials = await apiClient.get("/model-provider-credentials");
    const keys = (await credentials.json()).data as Array<{ id: string }>;
    expect(keys).toHaveLength(1);
    expect(retry.postDataJSON().credentialId).toBe(keys[0]!.id);

    const models = await listModels(apiClient);
    expect(models.find((m) => m.modelId === ADDABLE_MODEL)).toBeDefined();
    expect(models.find((m) => m.modelId === REFUSED_MODEL)).toBeUndefined();
  });

  test("detects through a key the org already saved", async ({ authedPage: page, apiClient }) => {
    const baseUrl = `${mockOrigin}/v1`;
    // Seeded over the API rather than by running the form twice: what this
    // test covers is the picker, not the key's creation.
    const seeded = await apiClient.post("/model-provider-credentials", {
      providerId: OPENAI_PROVIDER_ID,
      apiKey: GOOD_KEY,
      baseUrlOverride: baseUrl,
    });
    expect(seeded.status()).toBe(201);
    const credential = (await seeded.json()) as { id: string; label: string };

    // No URL and no key typed — the saved key carries both.
    const dialog = await openCustomEndpointForm(page, { apiType: OPENAI_TYPE });
    // A Radix select trigger is a `combobox` whose role forbids
    // name-from-content, so it has no accessible name: match on its placeholder
    // text (`models.form.useExistingKey`).
    await dialog.getByRole("combobox").filter({ hasText: "Mes clés" }).click();
    await page.getByRole("option", { name: credential.label, exact: true }).click();

    // The key was saved against an endpoint; the form follows it there and pins
    // the field rather than asking for the URL again.
    await expect(dialog.locator("#mdl-baseUrl")).toHaveValue(baseUrl);
    await expect(dialog.locator("#mdl-baseUrl")).toBeDisabled();

    await dialog.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(dialog.getByText("2 modèles détectés")).toBeVisible();
    await discoveredRow(dialog, SERVED_MODEL).click();
    await addModelsButton(dialog, 1).click();

    await expect(dialog).toBeHidden();
    const created = (await listModels(apiClient)).find((m) => m.modelId === SERVED_MODEL);
    // Bound to the key that was picked — no second credential was minted.
    expect(created).toMatchObject({ credentialId: credential.id, baseUrl });
  });

  test("reports a key the endpoint rejects", async ({ authedPage: page }) => {
    const dialog = await openCustomEndpointForm(page, {
      baseUrl: `${mockOrigin}/v1`,
      apiKey: "e2e-wrong-key",
      apiType: OPENAI_TYPE,
    });

    await dialog.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(dialog.getByText("Clé refusée par le endpoint.")).toBeVisible();
  });

  test("saves a manually typed model id and lets the server name the row", async ({
    authedPage: page,
    apiClient,
  }) => {
    const dialog = await openCustomEndpointForm(page, {
      baseUrl: `${mockOrigin}/v1`,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await dialog.getByRole("button", { name: "Configurer manuellement" }).click();
    await dialog.locator("#mdl-modelId").fill("llama3");

    // Nothing describes a typed-in id — no listing, and no catalog entry for a
    // name the operator invented — so the limits and modalities are a question
    // only they can answer. The toggle is off on a create: what is shown is
    // the fallback chain, not empty fields.
    await expect(dialog.locator("#mdl-ctx")).toBeHidden();
    await dialog
      .getByRole("checkbox", { name: "Définir moi-même les limites et capacités" })
      .click();
    await dialog.getByRole("checkbox", { name: "Image", exact: true }).click();
    await dialog.locator("#mdl-ctx").fill("32768");

    // Name left empty on purpose: the server derives it from the model id.
    await dialog.getByRole("button", { name: "Enregistrer" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText("llama3").first()).toBeVisible();

    const created = (await listModels(apiClient)).find((m) => m.modelId === "llama3");
    // The ticked boxes ARE the answer: `text` was already on, `image` was
    // added, and the context window is the one typed rather than the runtime's
    // 128k default.
    expect(created).toMatchObject({
      modelId: "llama3",
      label: "llama3",
      input: ["text", "image"],
      contextWindow: 32768,
    });
  });

  test("discovers an Anthropic-shaped endpoint's models", async ({
    authedPage: page,
    apiClient,
  }) => {
    // No `/v1`: the platform appends `/v1/models` for this shape.
    const dialog = await openCustomEndpointForm(page, {
      baseUrl: mockOrigin,
      apiKey: GOOD_KEY,
      apiType: ANTHROPIC_TYPE,
    });

    await dialog.getByRole("button", { name: "Détecter les modèles" }).click();
    await expect(dialog.getByText("1 modèle détecté")).toBeVisible();

    await discoveredRow(dialog, ANTHROPIC_MODEL).click();
    await addModelsButton(dialog, 1).click();

    await expect(dialog).toBeHidden();

    const created = (await listModels(apiClient)).find((m) => m.modelId === ANTHROPIC_MODEL);
    expect(created).toMatchObject({
      modelId: ANTHROPIC_MODEL,
      apiShape: "anthropic-messages",
    });
  });
});
