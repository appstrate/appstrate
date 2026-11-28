// SPDX-License-Identifier: Apache-2.0

/**
 * « Tous les espaces »: a client mode over a hidden working space, kept per account and org in
 * `localStorage` (`appstrate:web:overview`), the way the space switcher stores the reader's pick.
 */

import type { Browser, BrowserContext } from "@playwright/test";
import { createAuthedContext } from "../fixtures/browser.fixture.ts";
import type { AuthResult } from "./seed.ts";

/** A signed-in context in « Tous les espaces », over `hiddenSpaceId` as its working space. */
export async function createOverviewContext(
  browser: Browser,
  auth: AuthResult,
  orgId: string,
  hiddenSpaceId: string,
): Promise<BrowserContext> {
  const context = await createAuthedContext(browser, auth, orgId, hiddenSpaceId);
  await context.addInitScript(
    (key) => localStorage.setItem("appstrate:web:overview", JSON.stringify({ [key]: true })),
    `${auth.userId}:${orgId}`,
  );
  return context;
}

/** An org model, so « Lancer » is not held back for want of one. Nothing reaches the provider. */
export async function seedModel(client: {
  post(path: string, data?: unknown): Promise<import("@playwright/test").APIResponse>;
}): Promise<void> {
  const credential = await client.post("/model-provider-credentials", {
    providerId: "anthropic",
    api_key: "sk-ant-e2e",
  });
  if (credential.status() !== 201) throw new Error(`credential: ${await credential.text()}`);
  const model = await client.post("/models", {
    modelId: "claude-sonnet-4-5-20250929",
    config_id: (await credential.json()).config_id,
  });
  if (model.status() !== 201) throw new Error(`model: ${await model.text()}`);
}
