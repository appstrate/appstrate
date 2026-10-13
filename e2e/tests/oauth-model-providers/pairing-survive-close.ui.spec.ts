// SPDX-License-Identifier: Apache-2.0

/**
 * Browser coverage for a pairing whose modal is gone before the helper redeems
 * (apps/web: `pairing-store`, `<PendingPairingsWatcher>`, `OAuthPairingBody`,
 * `usePairingDismissConfirm`).
 *
 * Each test mints a pairing through the UI, then plays the helper's redeem
 * against the live server. They prove:
 *
 *   - closing the modal mid-flow never fires `DELETE /pairing`;
 *   - the watcher fires the success toast and refreshes the credential list
 *     with no modal open;
 *   - the pairing survives a full page reload (persisted to localStorage);
 *   - only non-secret fields are persisted, never the bearer token;
 *   - the localStorage entry is cleared once the pairing completes.
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import {
  SETTINGS_PATH,
  SUCCESS_TOAST,
  closePairingModal,
  deleteCredential,
  helperRedeem,
  openPairingModal,
  readStore,
} from "../../helpers/pairing.ts";

test.describe("OAuth Model Providers — pairing survives modal close @smoke", () => {
  test("closing the modal mid-flow does not drop the connection", async ({
    authedPage: page,
    apiClient,
  }) => {
    // Closing the modal never cancels its pairing: no DELETE is sent.
    const pairingDeletes: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "DELETE" && r.url().includes("/model-providers-oauth/pairing/")) {
        pairingDeletes.push(r.url());
      }
    });

    await page.goto(SETTINGS_PATH);
    const { token } = await openPairingModal(page);

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
      "target",
    ]);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("appp_");

    // Close the modal while busy → confirm-on-close guard, then confirm.
    await closePairingModal(page);

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
      await deleteCredential(apiClient, credentialId);
    }
  });

  test("pairing survives a full page reload", async ({ authedPage: page, apiClient }) => {
    await page.goto(SETTINGS_PATH);
    const { token } = await openPairingModal(page);
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
      await deleteCredential(apiClient, credentialId);
    }
  });
});
