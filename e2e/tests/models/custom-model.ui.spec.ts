// SPDX-License-Identifier: Apache-2.0

/**
 * Adding a gateway configuration and its models from org settings → Modèles,
 * against a mock endpoint this spec serves itself.
 *
 * The service picker offers one "Endpoint personnalisé" row for every base-URL-
 * overridable registry entry; which of them it is becomes the "Type d'API"
 * question of the configuration form. Both shapes it can speak are exercised here —
 * OpenAI (`GET <baseUrl>/models`, `Authorization: Bearer`) and Anthropic
 * (`GET <baseUrl>/v1/models`, `x-api-key`), which is why the two tests type a
 * different base URL against the same mock.
 *
 * A new configuration has no key yet, so its model list detects with a key typed
 * for that one request; the organization's key is the flow's last step. One
 * detection describes every model the endpoint serves, so the list adds them as
 * a batch, every detected model ticked. That makes three things worth asserting
 * beyond "a model was saved" — adding several at once, a batch the server only
 * partly accepts, and a detection run through the configuration's saved key.
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
import {
  SAVE,
  addConfiguration,
  configRow,
  connectDialog,
  listModels,
  modelChoiceDialog,
  modelRow,
} from "../../helpers/models.ts";
import type { ApiClient } from "../../helpers/api-client.ts";
import type { Locator, Page } from "@playwright/test";

const GOOD_KEY = "e2e-good-key";
/** The single picker row every overridable endpoint collapses into (`models.form.customEndpoint`). */
const CUSTOM_ENDPOINT = "Endpoint personnalisé";
/** Registry display names of the two custom-endpoint entries, the "Type d'API" options. */
const OPENAI_TYPE = "OpenAI-compatible (custom)";
const ANTHROPIC_TYPE = "Anthropic-compatible (custom)";
/** The provider id behind {@link OPENAI_TYPE}, for a configuration seeded over the API. */
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
 * it must refuse: `POST /api/models/apply` rejects `maxTokens >= contextWindow`
 * (createModelSchema's canonical budget invariant), and both numbers come
 * straight from what the endpoint published. Nothing else about a discovered
 * model is refusable here — a model the configuration already has is refused
 * too (`model_already_added`, backed by `uq_org_models_config_model` on
 * `(config_id, model_id)`), but a listing never offers one, so the budget
 * invariant is what stands in for a partial failure.
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
 * Open « Ajouter une configuration » on the custom-endpoint path: which API shape and where it
 * lives; lands on the model list with `apiKey` typed in its one-request key field. The shape is
 * always picked explicitly: the pre-selected entry is whichever the registry lists first, which
 * is not something a test should depend on.
 */
async function openCustomEndpointList(
  page: Page,
  { baseUrl, apiKey, apiType }: { baseUrl: string; apiKey: string; apiType: string },
): Promise<Locator> {
  const dialog = await addConfiguration(page, CUSTOM_ENDPOINT, { apiType, baseUrl });
  await dialog.locator("#model-choice-key").fill(apiKey);
  return dialog;
}

/** A gateway configuration seeded over the API, with its organization key. */
async function seedGateway(
  apiClient: Pick<ApiClient, "post">,
  baseUrl: string,
): Promise<{ configId: string; label: string }> {
  const label = `Gateway ${Date.now()}`;
  const config = await apiClient.post("/model-configs", {
    provider_id: OPENAI_PROVIDER_ID,
    base_url: baseUrl,
    label,
  });
  expect(config.status(), await config.text()).toBe(201);
  const configId = (await config.json()).id as string;
  const key = await apiClient.post("/model-provider-credentials", {
    providerId: OPENAI_PROVIDER_ID,
    api_key: GOOD_KEY,
    config_id: configId,
  });
  expect(key.status(), await key.text()).toBe(201);
  return { configId, label };
}

/** Open a seeded configuration's row, then its model list. */
async function openSavedList(page: Page, label: string): Promise<Locator> {
  await page.goto("/org-settings/models");
  const row = configRow(page, label);
  await row.getByRole("button", { name: `Ouvrir « ${label} »` }).click();
  await row.getByRole("button", { name: "Choisir les modèles" }).click();
  const dialog = modelChoiceDialog(page);
  await expect(dialog).toBeVisible();
  // The configuration's key detects: none is asked for.
  await expect(dialog.locator("#model-choice-key")).toHaveCount(0);
  return dialog;
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
    // Nothing describes a typed-in id, so the limits are a question only the operator can
    // answer; the toggle starts off, showing the fallback chain rather than empty fields.
    await expect(dialog.locator("#mdl-ctx")).toBeHidden();
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

/** Save the model list of a new configuration; the flow goes on to its key. */
async function saveNewList(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: SAVE, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(connectDialog(page)).toBeVisible();
}

/**
 * Detect on the split endpoint and submit both models: the first is accepted,
 * the second refused by the server. Resolves to the dialog once the refusal is
 * on screen, after checking that the list is frozen while the batch is in flight.
 */
async function submitPartlyRefusedBatch(page: Page): Promise<Locator> {
  const dialog = await openCustomEndpointList(page, {
    baseUrl: `${mockOrigin}${SPLIT_PATH}`,
    apiKey: GOOD_KEY,
    apiType: OPENAI_TYPE,
  });

  await detect(dialog, 2);
  const pendingRequest = Promise.withResolvers<void>();
  const releaseRequest = Promise.withResolvers<void>();
  await page.route("**/api/models/apply", async (route) => {
    if (route.request().method() === "POST") {
      pendingRequest.resolve();
      await releaseRequest.promise;
    }
    await route.continue();
  });
  await dialog.getByRole("button", { name: SAVE, exact: true }).click();
  await pendingRequest.promise;
  try {
    // While the batch is in flight the list cannot move under it.
    await expect(modelRow(dialog, REFUSED_MODEL)).toBeDisabled();
  } finally {
    releaseRequest.resolve();
  }
  await expect(dialog.getByText(`Impossible de terminer pour : ${REFUSED_MODEL}`)).toBeVisible();
  await page.unroute("**/api/models/apply");
  return dialog;
}

test.describe("Custom endpoint model — UI", () => {
  test("discovers an OpenAI-shaped endpoint's models, saves the checked one, then the key", async ({
    authedPage: page,
    apiClient,
  }) => {
    const baseUrl = `${mockOrigin}/v1`;
    const dialog = await openCustomEndpointList(page, {
      baseUrl,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await detect(dialog, 2);
    // Everything detected starts ticked: leave only the one the endpoint described itself.
    await expect(modelRow(dialog, CATALOG_MODEL)).toBeChecked();
    await expect(modelRow(dialog, SERVED_MODEL)).toBeChecked();
    await modelRow(dialog, CATALOG_MODEL).click();
    await expect(modelRow(dialog, CATALOG_MODEL)).not.toBeChecked();
    await saveNewList(page, dialog);

    const connect = connectDialog(page);
    await connect.locator("#pk-apiKey").fill(GOOD_KEY);
    await connect.getByRole("button", { name: SAVE, exact: true }).click();
    await expect(connect).toBeHidden();

    const models = await listModels(apiClient);
    expect(models.find((m) => m.modelId === CATALOG_MODEL)).toBeUndefined();
    const created = models.find((m) => m.modelId === SERVED_MODEL);
    // Every capability is written from the listing itself — the catalog does
    // not know this id, so the context window can only be the published hint.
    expect(created).toMatchObject({
      label: SERVED_MODEL,
      modelId: SERVED_MODEL,
      contextWindow: SERVED_CONTEXT,
      apiShape: "openai-completions",
      base_url: baseUrl,
    });
    // The key joined the configuration the models belong to.
    const keys = (await (await apiClient.get("/model-provider-credentials")).json()).data as Array<{
      config_id: string;
      owner_type: string;
    }>;
    expect(keys.filter((k) => k.config_id === created!.config_id)).toHaveLength(1);
  });

  test("adds every detected model in one batch", async ({ authedPage: page, apiClient }) => {
    const dialog = await openCustomEndpointList(page, {
      baseUrl: `${mockOrigin}/v1`,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await detect(dialog, 2);
    await expect(dialog.getByRole("checkbox", { name: "Tout sélectionner" })).toBeChecked();
    await saveNewList(page, dialog);

    const ids = (await listModels(apiClient)).map((m) => m.modelId);
    expect(ids).toEqual(expect.arrayContaining([CATALOG_MODEL, SERVED_MODEL]));
  });

  test("keeps the dialog open on a refused batch, names the refused model and writes nothing", async ({
    authedPage: page,
    apiClient,
  }) => {
    const dialog = await submitPartlyRefusedBatch(page);

    // The batch is one `POST /api/models/apply`, atomic: the refusal names the
    // model at fault, and since nothing was written every row stays checked.
    await expect(modelRow(dialog, REFUSED_MODEL)).toBeChecked();
    await expect(modelRow(dialog, ADDABLE_MODEL)).toBeChecked();

    const models = await listModels(apiClient);
    expect(models.find((m) => m.modelId === ADDABLE_MODEL)).toBeUndefined();
    expect(models.find((m) => m.modelId === REFUSED_MODEL)).toBeUndefined();
  });

  // Unchecking the refused model and submitting again saves the rest.
  test("saves the rest of a refused batch once the refused model is unchecked", async ({
    authedPage: page,
    apiClient,
  }) => {
    const dialog = await submitPartlyRefusedBatch(page);

    const applied: Array<{ add: Array<{ modelId: string }> }> = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/models/apply") && request.method() === "POST") {
        applied.push(request.postDataJSON());
      }
    });
    await modelRow(dialog, REFUSED_MODEL).uncheck();
    await saveNewList(page, dialog);

    expect(applied.map((body) => body.add.map((entry) => entry.modelId))).toEqual([
      [ADDABLE_MODEL],
    ]);
    const models = await listModels(apiClient);
    expect(models.filter((m) => m.modelId === ADDABLE_MODEL)).toHaveLength(1);
    expect(models.find((m) => m.modelId === REFUSED_MODEL)).toBeUndefined();
  });

  test("detects through the configuration's saved key", async ({ authedPage: page, apiClient }) => {
    // Seeded over the API rather than by running the flow: what this test
    // covers is the configuration's own model list, not its creation.
    const { configId, label } = await seedGateway(apiClient, `${mockOrigin}/v1`);

    const dialog = await openSavedList(page, label);
    await detect(dialog, 2);
    // A saved configuration lists what is already its own ticked; nothing else is.
    await expect(modelRow(dialog, SERVED_MODEL)).not.toBeChecked();
    await modelRow(dialog, SERVED_MODEL).click();
    await dialog.getByRole("button", { name: SAVE, exact: true }).click();

    await expect(dialog).toBeHidden();
    const created = (await listModels(apiClient)).find((m) => m.modelId === SERVED_MODEL);
    expect(created).toMatchObject({ config_id: configId, base_url: `${mockOrigin}/v1` });
  });

  test("reports a key the endpoint rejects", async ({ authedPage: page }) => {
    const dialog = await openCustomEndpointList(page, {
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
    const dialog = await openCustomEndpointList(page, {
      baseUrl: `${mockOrigin}/v1`,
      apiKey: GOOD_KEY,
      apiType: OPENAI_TYPE,
    });

    await addTypedModel(dialog, "llama3", { contextWindow: "32768", image: true });
    await expect(modelRow(dialog, "llama3")).toBeChecked();
    await saveNewList(page, dialog);

    const created = (await listModels(apiClient)).find((m) => m.modelId === "llama3");
    // No name typed: the server names the row after the id. The limits are the operator's own.
    expect(created).toMatchObject({
      label: "llama3",
      modelId: "llama3",
      input: ["text", "image"],
      contextWindow: 32768,
    });
  });

  test("adds a typed model id to a saved configuration", async ({
    authedPage: page,
    apiClient,
  }) => {
    const { configId, label } = await seedGateway(apiClient, `${mockOrigin}/v1`);

    const dialog = await openSavedList(page, label);
    await addTypedModel(dialog, "mistral-local");
    await dialog.getByRole("button", { name: SAVE, exact: true }).click();

    await expect(dialog).toBeHidden();
    const created = (await listModels(apiClient)).find((m) => m.modelId === "mistral-local");
    expect(created).toMatchObject({ config_id: configId, label: "mistral-local" });
  });

  test("discovers an Anthropic-shaped endpoint's models", async ({
    authedPage: page,
    apiClient,
  }) => {
    // No `/v1`: the platform appends `/v1/models` for this shape.
    const dialog = await openCustomEndpointList(page, {
      baseUrl: mockOrigin,
      apiKey: GOOD_KEY,
      apiType: ANTHROPIC_TYPE,
    });

    await detect(dialog, 1);
    await expect(modelRow(dialog, ANTHROPIC_MODEL)).toBeChecked();
    await saveNewList(page, dialog);

    const created = (await listModels(apiClient)).find((m) => m.modelId === ANTHROPIC_MODEL);
    expect(created).toMatchObject({
      modelId: ANTHROPIC_MODEL,
      apiShape: "anthropic-messages",
    });
  });
});
