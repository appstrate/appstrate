// SPDX-License-Identifier: Apache-2.0

/**
 * Browser coverage for the "pairing survives the modal being closed" fix
 * (apps/web: `pairing-store`, `<PendingPairingsWatcher>`, `OAuthPairingBody`,
 * `usePairingDismissConfirm`).
 *
 * The earlier UI smoke (`oauth-ui.ui.spec.ts`) only proves the page renders;
 * the API contract (`pairing-lifecycle.api.spec.ts`) only proves the
 * mint/redeem wiring. Neither exercises the actual regression this PR fixes:
 * the dashboard used to cancel the pending pairing when its modal unmounted,
 * so a helper that redeemed AFTER the user closed the modal hit a deleted
 * token and the credential was silently lost.
 *
 * Both tests drive the real browser against the live server, mint a pairing
 * through the UI, then simulate the helper's redeem (bearer-auth, the exact
 * path `@appstrate/connect-helper` uses) and assert the connection completes
 * via the session-level watcher — proving:
 *
 *   - closing the modal mid-flow does NOT fire `DELETE /pairing`;
 *   - the watcher fires the success toast + refreshes the credential list
 *     even though the modal that started the flow is gone;
 *   - the pairing survives a full page reload (persisted to localStorage);
 *   - only non-secret fields are persisted (never the bearer token);
 *   - the localStorage entry is cleared once the pairing completes.
 *
 * `claude-code` is used because it needs no identity claim (hook-less), so
 * the synthetic redeem body stays minimal.
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import type { Page } from "@playwright/test";

const SETTINGS_PATH = "/org-settings/models";
const PROVIDER_ID = "claude-code";
const PROVIDER_LABEL = /Claude Code/;
const STORAGE_KEY = "appstrate_pending_pairings";

const CREDENTIAL_DIALOG = "Ajouter une clé de provider de modèle";
const CONFIRM_DIALOG = "Fermer la fenêtre de connexion ?";
const SUCCESS_TOAST = "Provider OAuth connecté avec succès";

interface MintedPairing {
  token: string;
  command: string;
}

/**
 * Open the credentials sub-tab, launch the add-credential modal, pick the
 * OAuth provider, and return the freshly-minted command + bearer token read
 * straight from the rendered CLI command.
 */
async function mintPairingViaUi(page: Page): Promise<MintedPairing> {
  await page.getByRole("tab", { name: "Clés de providers de modèles", exact: true }).click();
  await page.getByRole("button", { name: "Ajouter une clé", exact: true }).first().click();

  const dialog = page.getByRole("dialog", { name: CREDENTIAL_DIALOG });
  await dialog.locator("#pk-provider").click();
  await page.getByRole("option", { name: PROVIDER_LABEL }).click();

  const code = dialog.locator("code");
  await expect(code).toContainText("npx @appstrate/connect-helper", { timeout: 15_000 });
  const command = (await code.innerText()).trim();
  const token = command.match(/appp_[\w.-]+/)?.[0];
  expect(token, `bearer token parsed from "${command}"`).toBeTruthy();

  return { token: token as string, command };
}

/** Simulate the helper redeeming the token (bearer-only, no cookie/org). */
async function helperRedeem(page: Page, token: string) {
  const res = await page.request.post("/api/model-providers-oauth/pair/redeem", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      providerId: PROVIDER_ID,
      label: "E2E survive-close",
      accessToken: `fake-${PROVIDER_ID}-access`,
      refreshToken: `fake-${PROVIDER_ID}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      email: `pairing-survive-${Date.now()}@example.test`,
    },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { credentialId: string };
}

async function readStore(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
}

test.describe("OAuth Model Providers — pairing survives modal close @smoke", () => {
  test("closing the modal mid-flow does not drop the connection", async ({
    authedPage: page,
    apiClient,
  }) => {
    // Fail loudly if the dashboard ever cancels the pairing on close again.
    const pairingDeletes: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "DELETE" && r.url().includes("/model-providers-oauth/pairing/")) {
        pairingDeletes.push(r.url());
      }
    });

    await page.goto(SETTINGS_PATH);
    const { token } = await mintPairingViaUi(page);

    // The pairing is registered for the watcher — non-secret fields only.
    const stored = await readStore(page);
    expect(stored).not.toBeNull();
    const persisted = JSON.parse(stored as string) as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect(Object.keys(persisted[0] ?? {}).sort()).toEqual([
      "expiresAt",
      "id",
      "orgId",
      "providerId",
    ]);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("appp_");

    // Close the modal while busy → confirm-on-close guard, then confirm.
    await page
      .getByRole("dialog", { name: CREDENTIAL_DIALOG })
      .getByRole("button", { name: "Fermer", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: CONFIRM_DIALOG })
      .getByRole("button", { name: "Fermer", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: CREDENTIAL_DIALOG })).toBeHidden();

    // Helper redeems AFTER the modal is gone — the watcher must complete it.
    const { credentialId } = await helperRedeem(page, token);

    try {
      // Watcher side effects: success toast + credential-list refresh.
      await expect(page.getByText(SUCCESS_TOAST)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Connecté en tant que/).first()).toBeVisible({ timeout: 15_000 });

      // Store cleared once completed; no cancel ever fired.
      await expect.poll(() => readStore(page), { timeout: 15_000 }).toBeNull();
      expect(pairingDeletes).toEqual([]);
    } finally {
      const del = await apiClient.delete(`/model-provider-credentials/${credentialId}`);
      expect([204, 404]).toContain(del.status());
    }
  });

  test("pairing survives a full page reload", async ({ authedPage: page, apiClient }) => {
    await page.goto(SETTINGS_PATH);
    const { token } = await mintPairingViaUi(page);
    expect(await readStore(page)).not.toBeNull();

    // Hard reload — the modal is gone; only the persisted pairing remains.
    await page.reload();
    await expect(page.getByRole("tab", { name: "Modèles", exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Helper redeems against the reloaded session — the watcher resumes from
    // localStorage and completes it.
    const { credentialId } = await helperRedeem(page, token);

    try {
      await expect(page.getByText(SUCCESS_TOAST)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => readStore(page), { timeout: 15_000 }).toBeNull();

      // Credential really landed (independent of which tab is shown).
      const list = await apiClient.get("/model-provider-credentials");
      const body = (await list.json()) as { data: { id: string }[] };
      expect(body.data.find((r) => r.id === credentialId)).toBeDefined();
    } finally {
      const del = await apiClient.delete(`/model-provider-credentials/${credentialId}`);
      expect([204, 404]).toContain(del.status());
    }
  });
});
