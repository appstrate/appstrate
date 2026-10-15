// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's per-space generation settings, set from the agent's *Paramètres ›
 * Modèle* section and read back after a reload and over the API. The section
 * saves itself: each pick is written at once, there is no save button.
 *
 * The reasoning level travels as `reasoning_level` inside `generation` (the
 * agent model route) and inside `generation_config` (the space placement row).
 * The form's editor key and its "back to Auto" path both read that one field
 * name, so a mismatch shows up either as a saved level the tab forgets after a
 * reload, or as an "Auto" that never clears the stored level.
 *
 * The model is the suite's built-in `e2e` system key (`SYSTEM_PROVIDER_KEYS` in
 * CI), `claude-sonnet-4-5`, whose catalog entry declares every reasoning level
 * supported — the level select is enabled without a real provider key. Its
 * reasoning is NOT temperature-compatible, so the level is set alone.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgent } from "../../helpers/seed.ts";
import type { Page } from "@playwright/test";

const SETTINGS_TAB = "Paramètres";
const MODEL_SECTION = "Modèle";
/** `models.generation.levels.high` — the option, and what the select then shows. */
const HIGH = "Élevé";
/**
 * `models.generation.reasoningInherit` interpolated with the level an unset
 * one resolves to on the selected model (`defaultReasoningLevel`) — here
 * `models.generation.levels.medium`. The reasoning select's "Auto" option.
 */
const REASONING_INHERIT = "Par défaut (Moyen)";

/**
 * The reasoning select. The model, temperature and reasoning selects carry no
 * accessible name of their own (the row's label is plain text beside them), so
 * it is the one whose value is either of the two states this test moves between.
 */
function reasoningSelect(page: Page) {
  return page.getByRole("combobox").filter({ hasText: /^(Par défaut \(Moyen\)|Élevé)$/ });
}

async function openModelSection(page: Page) {
  await page.getByRole("tab", { name: SETTINGS_TAB, exact: true }).click();
  await page.getByRole("link", { name: MODEL_SECTION, exact: true }).click();
}

function waitForModelPatch(page: Page, scope: string, name: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      decodeURIComponent(new URL(response.url()).pathname) === `/api/agents/${scope}/${name}/model`,
  );
}

test("an agent's reasoning level set in the UI persists across a reload and on the wire", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `gen-${Date.now().toString(36)}`;
  const spaceId = browserCtx.org.defaultSpaceId;
  await createAgent(apiClient, scope, name);

  // Precondition, not the assertion under test: the model this tab resolves
  // to must offer the level, or the toggle is rendered disabled.
  const models = await apiClient.get("/models");
  expect(models.status()).toBe(200);
  const defaultModel = (
    (await models.json()).data as Array<{
      is_default: boolean;
      generation?: { reasoning?: { levels?: Record<string, string> } };
    }>
  ).find((m) => m.is_default);
  expect(defaultModel?.generation?.reasoning?.levels?.high).toBe("supported");

  await page.goto(`/agents/${scope}/${name}`);
  await openModelSection(page);

  const reasoning = reasoningSelect(page);
  await expect(reasoning).toBeEnabled();
  const saved = waitForModelPatch(page, scope, name);
  await reasoning.click();
  await page.getByRole("option", { name: HIGH, exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({
    modelId: null,
    generation: { reasoning_level: "high" },
  });
  await expect(reasoning).toHaveText(HIGH);

  await page.reload();
  await expect(reasoningSelect(page)).toHaveText(HIGH);

  const agentModel = await apiClient.get(`/agents/${scope}/${name}/model`);
  expect(agentModel.status()).toBe(200);
  const agentModelBody = await agentModel.json();
  expect(agentModelBody).toEqual({ modelId: null, generation: { reasoning_level: "high" } });

  const placements = await apiClient.get(`/spaces/${spaceId}/packages`);
  expect(placements.status()).toBe(200);
  const placement = ((await placements.json()).data as Array<Record<string, unknown>>).find(
    (p) => p.packageId === `${scope}/${name}`,
  );
  expect(placement).toBeDefined();
  expect(placement!.generation_config).toEqual({ reasoning_level: "high" });
  expect(placement).not.toHaveProperty("generationConfig");

  // Back to "Auto": the level is removed rather than sent under another name,
  // and an empty settings object is saved as "inherit everything".
  const cleared = waitForModelPatch(page, scope, name);
  await reasoningSelect(page).click();
  await page.getByRole("option", { name: REASONING_INHERIT, exact: true }).click();
  const clearedResponse = await cleared;
  expect(clearedResponse.status()).toBe(200);
  expect(clearedResponse.request().postDataJSON()).toEqual({ modelId: null, generation: null });

  await page.reload();
  await expect(reasoningSelect(page)).toHaveText(REASONING_INHERIT);

  const afterClear = await apiClient.get(`/agents/${scope}/${name}/model`);
  expect((await afterClear.json()).generation).toBeNull();
});
