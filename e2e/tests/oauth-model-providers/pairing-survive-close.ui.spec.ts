// SPDX-License-Identifier: Apache-2.0

/**
 * Browser coverage for a pairing whose modal is gone before the helper redeems
 * (apps/web: `pairing-store`, `<PendingPairingsWatcher>`, `OAuthPairingBody`,
 * `usePairingDismissConfirm`). The tests prove:
 *
 *   - closing the modal mid-flow never fires `DELETE /pairing`;
 *   - the watcher toasts the success and refreshes the credential list with no
 *     modal open, then clears the localStorage entry;
 *   - the pairing survives a full page reload;
 *   - only non-secret fields are persisted, never the bearer token.
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import {
  CREDENTIAL_LABEL,
  SETTINGS_PATH,
  SUCCESS_TOAST,
  closePairingModal,
  credentialDialog,
  deleteCredential,
  helperRedeem,
  openModelToPersonalKeys,
  openPairingModal,
  readStore,
} from "../../helpers/pairing.ts";

test.describe("OAuth Model Providers — pairing survives modal close @smoke", () => {
  test("closing the modal mid-flow does not drop the connection", async ({
    authedPage: page,
    apiClient,
  }) => {
    const pairingDeletes: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "DELETE" && r.url().includes("/model-providers-oauth/pairing/")) {
        pairingDeletes.push(r.url());
      }
    });

    await openModelToPersonalKeys(apiClient);
    await page.goto(SETTINGS_PATH);
    const { token } = await openPairingModal(page);

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

    await closePairingModal(page);

    const { credentialId } = await helperRedeem(page, token);

    try {
      await expect(page.getByText(SUCCESS_TOAST)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("row").filter({ hasText: CREDENTIAL_LABEL })).toBeVisible({
        timeout: 15_000,
      });

      await expect.poll(() => readStore(page), { timeout: 15_000 }).toBeNull();
      expect(pairingDeletes).toEqual([]);
    } finally {
      await deleteCredential(apiClient, credentialId);
    }
  });

  test("pairing survives a full page reload", async ({ authedPage: page, apiClient }) => {
    await openModelToPersonalKeys(apiClient);
    await page.goto(SETTINGS_PATH);
    const { token } = await openPairingModal(page);
    expect(await readStore(page)).not.toBeNull();

    // Hard reload — the modal is addressed by the URL, so it comes back empty;
    // only the persisted pairing remains. Dismiss it to reach the page.
    await page.reload();
    await credentialDialog(page).getByRole("button", { name: "Annuler", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Mes clés de modèles" })).toBeVisible({
      timeout: 15_000,
    });

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
