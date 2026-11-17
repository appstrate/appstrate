// SPDX-License-Identifier: Apache-2.0

/**
 * Driving the OAuth model-provider pairing flow in a browser spec: the dashboard
 * through the real UI, the helper through the bearer route it posts to.
 * `claude-code` needs no identity claim, so the synthetic redeem body stays minimal.
 */

import { expect, type APIResponse, type Locator, type Page } from "@playwright/test";
import type { ApiClient } from "./api-client.ts";

/**
 * A subscription is personal, so it is added from Preferences › Mes clés de modèles (never from
 * the organization's settings).
 */
export const SETTINGS_PATH = "/preferences/models";
export const STORAGE_KEY = "appstrate_pending_pairings";
export const SUCCESS_TOAST = "Abonnement connecté avec succès";
/** The label the simulated helper names the credential with. */
export const CREDENTIAL_LABEL = "E2E pairing";

const PROVIDER_ID = "claude-code";
const PROVIDER_LABEL = /Claude Code/;
/** Any provider but the pairing's: the redeem route refuses the mismatch. */
const OTHER_PROVIDER_ID = "codex";

const CREDENTIAL_DIALOG = "Ajouter une clé perso ou un abonnement";
const CONFIRM_DIALOG = "Fermer la fenêtre de connexion ?";

interface DisplayedPairing {
  token: string;
  command: string;
}

export function credentialDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: CREDENTIAL_DIALOG });
}

/**
 * Preferences only offers the providers whose key would serve a model the organization opened to
 * personal keys: leave one of the provider's models to each person's own subscription first.
 */
export async function openModelToPersonalKeys(apiClient: ApiClient): Promise<void> {
  const registry = await apiClient.get("/model-provider-credentials/registry");
  expect(registry.status()).toBe(200);
  const provider = (
    (await registry.json()).data as Array<{ providerId: string; models: { id: string }[] }>
  ).find((p) => p.providerId === PROVIDER_ID);
  expect(provider?.models[0], `a catalogued ${PROVIDER_ID} model`).toBeDefined();
  const created = await apiClient.post("/models", {
    modelId: provider!.models[0]!.id,
    credentialId: null,
    providerId: PROVIDER_ID,
  });
  expect(created.status()).toBe(201);
}

/**
 * Opens the add-subscription modal from the page's Actions menu and returns the command it shows:
 * a fresh mint, or the pending pairing it resumes.
 */
export async function openPairingModal(page: Page): Promise<DisplayedPairing> {
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: CREDENTIAL_DIALOG }).click();

  const dialog = credentialDialog(page);
  await dialog.locator("#pk-provider").click();
  await page.getByRole("option", { name: PROVIDER_LABEL }).click();

  const code = dialog.locator("code");
  await expect(code).toContainText("npx @appstrate/connect-helper", { timeout: 15_000 });
  const command = (await code.innerText()).trim();
  const token = command.match(/appp_[\w.-]+/)?.[0];
  expect(token, `bearer token parsed from "${command}"`).toBeTruthy();

  return { token: token as string, command };
}

/**
 * Closes the modal while busy, then confirms the guard. The busy modal has no footer, so its
 * corner ✕ is the way out; the guard is an alert dialog, which has no ✕ of its own, so the
 * « Fermer » it shows is its confirm button.
 */
export async function closePairingModal(page: Page): Promise<void> {
  await credentialDialog(page).getByRole("button", { name: "Fermer", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: CONFIRM_DIALOG })
    .getByRole("button", { name: "Fermer", exact: true })
    .click();
  await expect(credentialDialog(page)).toBeHidden();
}

function postRedeem(page: Page, token: string, providerId: string): Promise<APIResponse> {
  return page.request.post("/api/model-providers-oauth/pair/redeem", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      providerId,
      label: CREDENTIAL_LABEL,
      access_token: `fake-${providerId}-access`,
      refresh_token: `fake-${providerId}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      email: `pairing-${Date.now()}@example.test`,
    },
  });
}

export async function helperRedeem(page: Page, token: string): Promise<{ credentialId: string }> {
  const res = await postRedeem(page, token, PROVIDER_ID);
  expect(res.status()).toBe(200);
  return (await res.json()) as { credentialId: string };
}

/** The token is spent, no credential is created, and the pairing reads `failed`. */
export async function helperRedeemRefused(page: Page, token: string): Promise<void> {
  const res = await postRedeem(page, token, OTHER_PROVIDER_ID);
  expect(res.status()).toBe(400);
}

/** `null` once the list is empty. */
export async function readStore(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
}

export async function deleteCredential(apiClient: ApiClient, credentialId: string): Promise<void> {
  const del = await apiClient.delete(`/model-provider-credentials/${credentialId}`);
  expect([204, 404]).toContain(del.status());
}
