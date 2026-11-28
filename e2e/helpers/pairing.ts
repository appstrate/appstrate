// SPDX-License-Identifier: Apache-2.0

/**
 * Driving the OAuth model-provider pairing flow in a browser spec: the dashboard
 * through the real UI, the helper through the bearer route it posts to.
 * `claude-code` needs no identity claim, so the synthetic redeem body stays minimal.
 */

import { expect, type APIResponse, type Locator, type Page } from "@playwright/test";
import type { ApiClient } from "./api-client.ts";
import { configRow } from "./models.ts";

/**
 * A personal subscription is added from Preferences › Models, on the row of the configuration it
 * joins (« Utiliser ma connexion », then the subscription in its menu).
 */
export const SETTINGS_PATH = "/preferences/models";
export const STORAGE_KEY = "appstrate:web:pendingPairings";
export const SUCCESS_TOAST = "Abonnement connecté avec succès";
/** The label the simulated helper names the credential with. */
const CREDENTIAL_LABEL = "E2E pairing";

const PROVIDER_ID = "claude-code";
const PROVIDER_LABEL = /Claude Code/;
/** Any provider but the pairing's: the redeem route refuses the mismatch. */
const OTHER_PROVIDER_ID = "codex";

/** The configuration a `claude-code` subscription joins: its family's, Anthropic. */
const CONFIG_LABEL = "Anthropic";
const CREDENTIAL_DIALOG = `Connecter « ${CONFIG_LABEL} »`;
const CONFIRM_DIALOG = "Fermer la fenêtre de connexion ?";

interface DisplayedPairing {
  token: string;
  command: string;
}

/** The row of the configuration the pairing joins, on the Preferences page. */
/** The Anthropic configuration's row, where a Claude Code subscription is paired. */
export function anthropicRow(page: Page): Locator {
  return configRow(page, CONFIG_LABEL);
}

export function credentialDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: CREDENTIAL_DIALOG });
}

/**
 * Preferences only lists the configurations open to personal connections: make sure the family
 * of the pairing's provider has one (a `409 model_config_exists` means it already does).
 */
export async function openModelToPersonalKeys(apiClient: ApiClient): Promise<void> {
  const created = await apiClient.post("/model-configs", {
    provider_id: PROVIDER_ID,
    personal_connections_allowed: true,
  });
  expect([201, 409]).toContain(created.status());
  if (created.status() === 409) {
    const id = (await created.json()).existing_config_id as string;
    const opened = await apiClient.patch(`/model-configs/${id}`, {
      personal_connections_allowed: true,
    });
    expect(opened.status()).toBe(200);
  }
}

/**
 * Opens the pairing modal from the configuration's row (its connect menu, the subscription) and
 * returns the command it shows: a fresh mint, or the pending pairing it resumes.
 */
export async function openPairingModal(page: Page): Promise<DisplayedPairing> {
  await anthropicRow(page).getByRole("button", { name: "Autres façons de connecter" }).click();
  await page.getByRole("menuitem", { name: PROVIDER_LABEL }).click();

  const dialog = credentialDialog(page);

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

function postRedeem(
  page: Page,
  token: string,
  providerId: string,
  email = `pairing-${Date.now()}@example.test`,
): Promise<APIResponse> {
  return page.request.post("/api/model-providers-oauth/pair/redeem", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      providerId,
      label: CREDENTIAL_LABEL,
      access_token: `fake-${providerId}-access`,
      refresh_token: `fake-${providerId}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      email,
    },
  });
}

/** The credential the helper stored, and the account it names: what the row then reads. */
export async function helperRedeem(
  page: Page,
  token: string,
): Promise<{ credentialId: string; email: string }> {
  const email = `pairing-${Date.now()}@example.test`;
  const res = await postRedeem(page, token, PROVIDER_ID, email);
  expect(res.status()).toBe(200);
  const { credentialId } = (await res.json()) as { credentialId: string };
  return { credentialId, email };
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
