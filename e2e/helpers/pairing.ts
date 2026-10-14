// SPDX-License-Identifier: Apache-2.0

/**
 * Driving the OAuth model-provider pairing flow in a browser spec: the dashboard
 * through the real UI, the helper through the bearer route it posts to.
 * `claude-code` needs no identity claim, so the synthetic redeem body stays minimal.
 */

import { expect, type APIResponse, type Locator, type Page } from "@playwright/test";
import type { ApiClient } from "./api-client.ts";

export const SETTINGS_PATH = "/org-settings/models";
export const STORAGE_KEY = "appstrate_pending_pairings";
export const SUCCESS_TOAST = "Provider OAuth connecté avec succès";

const PROVIDER_ID = "claude-code";
const PROVIDER_LABEL = /Claude Code/;
/** Any provider but the pairing's: the redeem route refuses the mismatch. */
const OTHER_PROVIDER_ID = "codex";

const CREDENTIAL_DIALOG = "Ajouter une clé de provider de modèle";
const CONFIRM_DIALOG = "Fermer la fenêtre de connexion ?";

interface DisplayedPairing {
  token: string;
  command: string;
}

export function credentialDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: CREDENTIAL_DIALOG });
}

/** Returns the command the modal shows: a fresh mint, or the pending pairing it resumes. */
export async function openPairingModal(page: Page): Promise<DisplayedPairing> {
  await page.getByRole("tab", { name: "Clés de providers de modèles", exact: true }).click();
  await page.getByRole("button", { name: "Ajouter une clé", exact: true }).first().click();

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
 * Both clicks are the dialog's own text button, not its corner ✕: the ✕ carries
 * the same accessible name ("Fermer") through a screen-reader-only label.
 */
export async function closePairingModal(page: Page): Promise<void> {
  const closeButton = (dialogName: string) =>
    page
      .getByRole("dialog", { name: dialogName })
      .getByRole("button", { name: "Fermer", exact: true })
      .filter({ hasNot: page.locator(".sr-only") });
  await closeButton(CREDENTIAL_DIALOG).click();
  await closeButton(CONFIRM_DIALOG).click();
  await expect(credentialDialog(page)).toBeHidden();
}

function postRedeem(page: Page, token: string, providerId: string): Promise<APIResponse> {
  return page.request.post("/api/model-providers-oauth/pair/redeem", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      providerId,
      label: "E2E pairing",
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
