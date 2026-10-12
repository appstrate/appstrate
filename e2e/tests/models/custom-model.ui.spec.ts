// SPDX-License-Identifier: Apache-2.0

/**
 * Adding a key and models on a custom endpoint from org settings → Modèles,
 * against a mock endpoint this spec serves itself.
 *
 * The provider picker offers one "Endpoint personnalisé" row for every base-URL-
 * overridable registry entry; which of them it is becomes the "Type d'API"
 * question inside the key form. Both shapes it can speak are exercised here —
 * OpenAI (`GET <baseUrl>/models`, `Authorization: Bearer`) and Anthropic
 * (`GET <baseUrl>/v1/models`, `x-api-key`), which is why the two tests type a
 * different base URL against the same mock.
 *
 * One detection describes every model the endpoint serves, so the second step
 * adds them as a batch: the listing is a checkbox list, every detected model
 * starts ticked. That makes three things worth asserting beyond "a model was
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
import { openRowMenuItem } from "../../helpers/table.ts";
import { NEXT, modelRow, openAddKeyDialog, submitAddKey } from "../../helpers/models.ts";
import type { APIResponse, Locator, Page } from "@playwright/test";

const GOOD_KEY = "e2e-good-key";
/** The single picker row every overridable endpoint collapses into (`models.form.customEndpoint`). */
const CUSTOM_ENDPOINT = "Endpoint personnalisé";
/** Registry display names of the two custom-endpoint entries, the "Type d'API" options. */
const OPENAI_TYPE = "OpenAI-compatible (custom)";
const ANTHROPIC_TYPE = "Anthropic-compatible (custom)";
/** The provider id behind {@link OPENAI_TYPE}, for a credential seeded over the API. */
const OPENAI_PROVIDER_ID = "openai-compatible";

/**
 * What the default path serves. `gpt-4o` is described by Pi's model registry
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
 * Open « Ajouter une clé org » on the custom-endpoint path and answer step 1:
 * which API shape, where it lives, and the key that opens it; lands on the
 * second step, the models. The shape is always picked explicitly: the
 * pre-selected entry is whichever the registry lists first, which is not
 * something a test should depend on.
 */
async function openCustomEndpointForm(
  page: Page,
  { baseUrl, apiKey, apiType }: { baseUrl: string; apiKey: string; apiType: string },
): Promise<Locator> {
  const dialog = await openAddKeyDialog(page);

  await selectOption(page, "pk-provider", CUSTOM_ENDPOINT);
  await selectOption(page, "pk-apiType", apiType);
  await dialog.locator("#pk-baseUrl").fill(baseUrl);
  await dialog.locator("#pk-apiKey").fill(apiKey);
  await dialog.getByRole("button", { name: NEXT, exact: true }).click();
  return dialog;
}

/** The model row of the second step, matched on the model's id. */
function discoveredRow(dialog: Locator, modelId: string): Locator {
  return modelRow(dialog, modelId);
}

/**
 * « Ajouter un identifiant de modèle »: type an id on the list's last line, optionally set the
 * limits the endpoint cannot publish, and add it to the list.
 */
async function addTypedModel(
  dialog: Locator,
  modelId: string,
  capabilities?: { contextWindow: string; image: boolean },
): Promise<void> {
  await dialog.getByRole("button", { name: "Ajouter un identifiant de modèle" }).click();
  await dialog.getByLabel("Modèle", { exact: true }).fill(modelId);
  if (capabilities) {
    await dialog
      .getByRole("checkbox", { name: "Définir moi-même les limites et capacités" })
      .click();
    await dialog.getByLabel("Fenêtre de contexte").fill(capabilities.contextWindow);
    if (capabilities.image) await dialog.getByRole("checkbox", { name: "Image" }).click();
  }
  await dialog.getByRole("button", { name: "Ajouter à la liste" }).click();
}

async function detect(dialog: Locator, count: number): Promise<void> {
  await dialog.getByRole("button", { name: "Détecter les modèles" }).click();
  await expect(
    dialog.getByText(count === 1 ? "1 modèle détecté" : `${count} modèles détectés`),
  ).toBeVisible();
}

/**
 * Detect on the split endpoint and submit both models: the first is accepted,
 * the second refused by the server. Resolves to the dialog once the refusal is
 * on screen, after checking that the list is frozen while the batch is in flight.
 */
async function submitPartlyRefusedBatch(page: Page): Promise<Locator> {
  const dialog = await openCustomEndpointForm(page, {
    baseUrl: `${mockOrigin}${SPLIT_PATH}`,
    apiKey: GOOD_KEY,
    apiType: OPENAI_TYPE,
  });

  await detect(dialog, 2);
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
  await submitAddKey(dialog).click();
  await pendingRequest.promise;
  try {
    // While the batch is in flight the list cannot move under it.
    await expect(discoveredRow(dialog, REFUSED_MODEL)).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Retour" })).toBeDisabled();
  } finally {
    releaseRequest.resolve();
  }
  await expect(dialog.getByText(`Impossible de terminer pour : ${REFUSED_MODEL}`)).toBeVisible();
  return dialog;
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

    await detect(dialog, 2);
    // Everything detected starts ticked: leave only the one the endpoint described itself.
    await expect(discoveredRow(dialog, CATALOG_MODEL)).toBeChecked();
    await expect(discoveredRow(dialog, SERVED_MODEL)).toBeChecked();
    await discoveredRow(dialog, CATALOG_MODEL).click();
    await expect(discoveredRow(dialog, CATALOG_MODEL)).not.toBeChecked();
    await submitAddKey(dialog).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(SERVED_MODEL).first()).toBeVisible();

    const models = await listModels(apiClient);
    expect(models.find((m) => m.modelId === CATALOG_MODEL)).toBeUndefined();
    const created = models.find((m) => m.modelId === SERVED_MODEL);
    expect(created).toBeDefined();
    // Every capability is written from the listing itself — the catalog does
    // not know this id, so the context window can only be the published hint.
    expect(created).toMatchObject({
      label: SERVED_MODEL,
      modelId: SERVED_MODEL,
      contextWindow: SERVED_CONTEXT,
      apiShape: "openai-completions",
      base_url: baseUrl,
    });
  });

  test("adds every detected model in one batch", async ({ authedPage: page }) => {
    const dialog = await openCustomEndpointForm(page, {
      baseUrl: `${mockOrigin}/v1`,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await detect(dialog, 2);
    await expect(dialog.getByRole("checkbox", { name: "Tout sélectionner" })).toBeChecked();
    await submitAddKey(dialog).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(CATALOG_MODEL).first()).toBeVisible();
    await expect(page.getByText(SERVED_MODEL).first()).toBeVisible();
  });

  test("keeps the dialog open on a partly refused batch and names what was refused", async ({
    authedPage: page,
    apiClient,
  }) => {
    const dialog = await submitPartlyRefusedBatch(page);

    // One `POST /api/models` per checked row, each refusal collected rather
    // than aborting the rest: the accepted model is saved, the refused one is
    // named and stays checked.
    await expect(dialog.getByText(`Impossible de terminer pour : ${REFUSED_MODEL}`)).toBeVisible();
    await expect(discoveredRow(dialog, REFUSED_MODEL)).toBeChecked();

    // The key was minted once and the accepted model saved once.
    const credentials = await apiClient.get("/model-provider-credentials");
    const keys = ((await credentials.json()).data as Array<{ id: string; source: string }>).filter(
      (k) => k.source === "custom",
    );
    expect(keys).toHaveLength(1);
    const models = await listModels(apiClient);
    expect(models.filter((m) => m.modelId === ADDABLE_MODEL)).toHaveLength(1);
    expect(models.find((m) => m.modelId === REFUSED_MODEL)).toBeUndefined();
  });

  // The retry asks only for what failed: the model the first attempt saved is not posted again
  // (the server would answer 409 `model_already_added`) and is not reported as failed.
  test("re-offers only what failed after a partly refused batch", async ({ authedPage: page }) => {
    const dialog = await submitPartlyRefusedBatch(page);

    const retried: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/models") && request.method() === "POST") {
        retried.push(request.postDataJSON().modelId);
      }
    });
    await submitAddKey(dialog).click();
    await expect(dialog.getByText(`Impossible de terminer pour : ${REFUSED_MODEL}`)).toBeVisible();

    expect(retried).toEqual([REFUSED_MODEL]);
  });

  test("detects through a key the org already saved", async ({ authedPage: page, apiClient }) => {
    const baseUrl = `${mockOrigin}/v1`;
    // Seeded over the API rather than by running the form twice: what this
    // test covers is the key's own model list, not the key's creation.
    const seeded = await apiClient.post("/model-provider-credentials", {
      providerId: OPENAI_PROVIDER_ID,
      api_key: GOOD_KEY,
      base_url_override: baseUrl,
    });
    expect(seeded.status()).toBe(201);
    const credential = (await seeded.json()) as { id: string; label: string };

    // No URL and no key typed — the saved key carries both.
    await page.goto("/org-settings/models");
    await openRowMenuItem(page, credential.label, "Choisir les modèles");
    const dialog = page.getByRole("dialog", { name: /^Modèles disponibles avec/ });
    await expect(dialog).toBeVisible();

    await detect(dialog, 2);
    // A saved key lists what is already its own ticked; nothing else is.
    await expect(discoveredRow(dialog, SERVED_MODEL)).not.toBeChecked();
    await discoveredRow(dialog, SERVED_MODEL).click();
    await dialog.getByRole("button", { name: "Enregistrer" }).click();

    await expect(dialog).toBeHidden();
    const created = (await listModels(apiClient)).find((m) => m.modelId === SERVED_MODEL);
    // Bound to the key that was picked — no second credential was minted.
    expect(created).toMatchObject({ credentialId: credential.id, base_url: baseUrl });
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

  // An endpoint that publishes no listing gets its models by typing their ids: the last line of
  // the list, « Ajouter un identifiant de modèle », opens the model form's manual fields, and the
  // id typed joins the list, ticked. Nothing is detected here: the endpoint is never asked.
  test("saves a manually typed model id and lets the server name the row", async ({
    authedPage: page,
    apiClient,
  }) => {
    const dialog = await openCustomEndpointForm(page, {
      baseUrl: `${mockOrigin}/v1`,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await addTypedModel(dialog, "llama3", { contextWindow: "32768", image: true });
    await expect(discoveredRow(dialog, "llama3")).toBeChecked();
    await submitAddKey(dialog).click();

    await expect(dialog).toBeHidden();
    const created = (await listModels(apiClient)).find((m) => m.modelId === "llama3");
    // No name typed: the server names the row after the id. The limits are the operator's own.
    expect(created).toMatchObject({
      label: "llama3",
      modelId: "llama3",
      input: ["text", "image"],
      contextWindow: 32768,
    });
  });

  test("adds a typed model id to a key the org already saved", async ({
    authedPage: page,
    apiClient,
  }) => {
    const seeded = await apiClient.post("/model-provider-credentials", {
      providerId: OPENAI_PROVIDER_ID,
      api_key: GOOD_KEY,
      base_url_override: `${mockOrigin}/v1`,
    });
    expect(seeded.status()).toBe(201);
    const credential = (await seeded.json()) as { id: string; label: string };

    await page.goto("/org-settings/models");
    await openRowMenuItem(page, credential.label, "Choisir les modèles");
    const dialog = page.getByRole("dialog", { name: /^Modèles disponibles avec/ });
    await expect(dialog).toBeVisible();

    await addTypedModel(dialog, "mistral-local");
    await dialog.getByRole("button", { name: "Enregistrer" }).click();

    await expect(dialog).toBeHidden();
    const created = (await listModels(apiClient)).find((m) => m.modelId === "mistral-local");
    expect(created).toMatchObject({ credentialId: credential.id, label: "mistral-local" });
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

    await detect(dialog, 1);
    await expect(discoveredRow(dialog, ANTHROPIC_MODEL)).toBeChecked();
    await submitAddKey(dialog).click();

    await expect(dialog).toBeHidden();

    const created = (await listModels(apiClient)).find((m) => m.modelId === ANTHROPIC_MODEL);
    expect(created).toMatchObject({
      modelId: ANTHROPIC_MODEL,
      apiShape: "anthropic-messages",
    });
  });
});
