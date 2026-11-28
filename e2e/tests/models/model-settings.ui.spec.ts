// SPDX-License-Identifier: Apache-2.0

/**
 * The settings of the models that are one control each, written at once, then read back through
 * the API: the organization's default model (Settings › Models, « Modèle par défaut »), a
 * configuration's switch for members' own connections, and a member connecting a personal API
 * key from Preferences › Models.
 *
 * Nothing here talks to a model provider: the keys are rows, never used.
 */

import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { MODELS_SETTINGS_PATH, SAVE, configRow, listModels } from "../../helpers/models.ts";
import { createOrgOnlyClient, type ApiClient } from "../../helpers/api-client.ts";
import { registerUser } from "../../helpers/seed.ts";
import type { Locator, Page } from "@playwright/test";

/** Two ids the catalog carries for Anthropic (neither is described by the spec). */
const FIRST_MODEL = "claude-sonnet-4-5-20250929";
const SECOND_MODEL = "claude-opus-4-7";

/** Anthropic's configuration, an organization key under it, and two of its models. */
async function seedAnthropic(
  apiClient: Pick<ApiClient, "post" | "get">,
): Promise<{ configId: string }> {
  const key = await apiClient.post("/model-provider-credentials", {
    providerId: "anthropic",
    api_key: "sk-ant-e2e",
  });
  expect(key.status(), await key.text()).toBe(201);
  const configId = (await key.json()).config_id as string;
  for (const modelId of [FIRST_MODEL, SECOND_MODEL]) {
    const model = await apiClient.post("/models", { modelId, config_id: configId });
    expect(model.status(), await model.text()).toBe(201);
  }
  return { configId };
}

async function configuration(
  apiClient: Pick<ApiClient, "get">,
  configId: string,
): Promise<{ personal_connections_allowed: boolean }> {
  const res = await apiClient.get("/model-configs");
  expect(res.status()).toBe(200);
  const configs = (await res.json()).data as Array<{
    id: string;
    personal_connections_allowed: boolean;
  }>;
  const found = configs.find((c) => c.id === configId);
  expect(found).toBeDefined();
  return found!;
}

async function openRow(page: Page, label: string): Promise<Locator> {
  await page.goto(MODELS_SETTINGS_PATH);
  const row = configRow(page, label);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: `Ouvrir « ${label} »` }).click();
  return row;
}

test.describe("Model settings — UI", () => {
  test("chooses the organization's default model, and the API says the same", async ({
    authedPage: page,
    apiClient,
  }) => {
    await seedAnthropic(apiClient);
    const before = (await listModels(apiClient)).filter((m) => m.source !== "built-in");
    const current = before.find((m) => m.is_default === true);
    const target = before.find((m) => m.is_default !== true);
    expect(target, "a second model to choose").toBeDefined();

    await page.goto(MODELS_SETTINGS_PATH);
    const picker = page.getByRole("group", { name: "Modèle par défaut" }).getByRole("combobox");
    await expect(picker).toBeVisible();
    await picker.click();
    await page.getByRole("option", { name: new RegExp(String(target!.label)) }).click();

    await expect
      .poll(async () => (await listModels(apiClient)).find((m) => m.is_default === true)?.id, {
        timeout: 15_000,
      })
      .toBe(target!.id);
    if (current) {
      const now = await listModels(apiClient);
      expect(now.find((m) => m.id === current.id)?.is_default).toBe(false);
    }
  });

  test("switches members' own connections off and on for a configuration", async ({
    authedPage: page,
    apiClient,
  }) => {
    const { configId } = await seedAnthropic(apiClient);
    const opened = await apiClient.patch(`/model-configs/${configId}`, {
      personal_connections_allowed: true,
    });
    expect(opened.status()).toBe(200);

    const row = await openRow(page, "Anthropic");
    const toggle = row.getByRole("switch");
    await expect(toggle).toBeChecked();

    // No member holds one yet: nothing to confirm, the switch writes at once.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => (await configuration(apiClient, configId)).personal_connections_allowed, {
        timeout: 15_000,
      })
      .toBe(false);

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect
      .poll(async () => (await configuration(apiClient, configId)).personal_connections_allowed, {
        timeout: 15_000,
      })
      .toBe(true);
  });

  test("lets a member connect their own API key from Preferences", async ({
    request,
    browser,
    browserCtx,
    apiClient,
    orgOnlyClient,
  }) => {
    const orgId = browserCtx.org.orgId;
    const { configId } = await seedAnthropic(apiClient);
    const opened = await apiClient.patch(`/model-configs/${configId}`, {
      personal_connections_allowed: true,
    });
    expect(opened.status()).toBe(200);

    const member = await registerUser(request);
    const invited = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
      email: member.email,
      role: "member",
      space_assignments: [],
    });
    expect(invited.status()).toBe(201);
    const { token } = await invited.json();
    const accepted = await request.post(`/invite/${token}/accept`, {
      headers: { Cookie: member.cookie, Origin: "http://localhost:3000" },
    });
    expect(accepted.status()).toBe(200);

    const context = await createAuthedContext(
      browser,
      member,
      orgId,
      browserCtx.org.defaultSpaceId,
    );
    try {
      const page = await context.newPage();
      await page.goto("/preferences/models");
      const row = page.locator("[data-row]").filter({ hasText: "Anthropic" });
      await expect(row).toBeVisible();
      // The organization's connection serves the member until they bring their own.
      await expect(row.getByText("Servi par la connexion de l'organisation")).toBeVisible();

      await row.getByRole("button", { name: "Utiliser ma connexion", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Connecter « Anthropic »" });
      await dialog.getByPlaceholder("sk-...").fill("sk-ant-member-e2e");
      await dialog.getByRole("button", { name: SAVE, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(row.getByText(/^Ma connexion · /)).toBeVisible();

      // Read back as the member: a personal connection of theirs, in that configuration.
      const memberClient = createOrgOnlyClient(request, member.cookie, orgId);
      const list = await memberClient.get("/model-provider-credentials");
      expect(list.status()).toBe(200);
      const mine = ((await list.json()).data as Array<Record<string, unknown>>).filter(
        (c) => c.owner_type === "user" && c.owner_id === member.userId,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ config_id: configId, authMode: "api_key" });
    } finally {
      await context.close();
    }
  });
});
