// SPDX-License-Identifier: Apache-2.0

/**
 * Browser coverage for how the dashboard reads the outcome of a pairing
 * (apps/web: `useModelProviderPairingStatus`, `pairing-store`,
 * `<PendingPairingsWatcher>`, `OAuthPairingBody`).
 *
 * Each test mints a pairing through the UI, then plays the helper's redeem
 * against the live server, accepted or refused. They prove:
 *
 *   - a 5xx on the status route does not end the poll: it keeps asking, and
 *     reports the success once the route answers again;
 *   - a pending pairing whose `expiresAt` has passed on the client clock is
 *     still polled after a reload: the server's answer is what ends it;
 *   - reopening the modal on the same provider shows the pending pairing's
 *     command without a second mint, the command stays out of localStorage,
 *     and the redeem closes that modal;
 *   - a refused redeem is told once: by the modal when it shows the pairing,
 *     by the watcher's toast when no modal does.
 *
 * A refused redeem creates no credential, so those two tests clean nothing up.
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import type { Locator, Page } from "@playwright/test";
import {
  SETTINGS_PATH,
  STORAGE_KEY,
  SUCCESS_TOAST,
  closePairingModal,
  credentialDialog,
  deleteCredential,
  helperRedeem,
  helperRedeemRefused,
  openPairingModal,
  readStore,
} from "../../helpers/pairing.ts";

const MINT_PATH = "/api/model-providers-oauth/pairing";
/** The status poll alone: neither the mint (`/pairing`) nor `/pair/redeem` match. */
const STATUS_ROUTE = "**/api/model-providers-oauth/pairing/pair_*";
const BAD_GATEWAY_PAGE = "<html><body><h1>502 Bad Gateway</h1></body></html>";

const PAIRING_FAILED =
  "La connexion n'a pas abouti : le compte n'a pas été enregistré. Générez une nouvelle commande pour réessayer.";
const REGENERATE_BUTTON = "Générer une nouvelle commande";

/**
 * Sonner mounts a toast one task after it is fired and keeps it 4 s: once this
 * has elapsed, a toast fired by an effect that has run is on screen.
 */
const TOAST_MOUNT_MS = 500;

function toast(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

test.describe("OAuth Model Providers — pairing poll @smoke", () => {
  test("keeps polling through a 502", async ({ authedPage: page, apiClient }) => {
    await page.goto(SETTINGS_PATH);
    const { token } = await openPairingModal(page);
    await closePairingModal(page);

    // A proxy's own page, not a problem+json: the client reads no answer in it.
    let served = 0;
    await page.route(STATUS_ROUTE, async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 502, contentType: "text/html", body: BAD_GATEWAY_PAGE });
      served += 1;
    });

    // Two responses are a request and its retry, where the query errors; a
    // third is the poll going on.
    await expect.poll(() => served, { timeout: 15_000 }).toBeGreaterThan(2);

    const { credentialId } = await helperRedeem(page, token);

    try {
      await page.unroute(STATUS_ROUTE);
      await expect(toast(page, SUCCESS_TOAST)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => readStore(page), { timeout: 15_000 }).toBeNull();
    } finally {
      await deleteCredential(apiClient, credentialId);
    }
  });

  test("reports a success read after the client-side expiry", async ({
    authedPage: page,
    apiClient,
  }) => {
    await page.goto(SETTINGS_PATH);
    const { token } = await openPairingModal(page);
    await closePairingModal(page);

    // The client clock says the pairing is over; the server still holds it pending.
    const expiredAt = await page.evaluate((key) => {
      const past = new Date(Date.now() - 3 * 60_000).toISOString();
      const entries = JSON.parse(localStorage.getItem(key) ?? "[]") as Record<string, unknown>[];
      localStorage.setItem(key, JSON.stringify(entries.map((e) => ({ ...e, expiresAt: past }))));
      return past;
    }, STORAGE_KEY);

    await page.reload();
    await expect(page.getByRole("tab", { name: "Modèles", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // The load keeps the entry: only its poll ends it.
    expect(await readStore(page)).toContain(expiredAt);

    const { credentialId } = await helperRedeem(page, token);

    try {
      await expect(toast(page, SUCCESS_TOAST)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => readStore(page), { timeout: 15_000 }).toBeNull();
    } finally {
      await deleteCredential(apiClient, credentialId);
    }
  });

  test("reopening the modal resumes the pending pairing", async ({
    authedPage: page,
    apiClient,
  }) => {
    let mints = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === MINT_PATH) mints += 1;
    });

    await page.goto(SETTINGS_PATH);
    const minted = await openPairingModal(page);
    await closePairingModal(page);

    const resumed = await openPairingModal(page);
    expect(resumed.command).toBe(minted.command);
    expect(mints).toBe(1);

    // The pairing is persisted, the command it resumes with is not.
    const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(persisted).toContain(STORAGE_KEY);
    expect(persisted).not.toContain("appp_");

    const { credentialId } = await helperRedeem(page, minted.token);

    try {
      // Nothing is clicked: the redeem closes the modal that shows the pairing.
      await expect(credentialDialog(page)).toBeHidden({ timeout: 15_000 });
      // The watcher drops the entry in the effect that fires its toast.
      await expect.poll(() => readStore(page), { timeout: 15_000 }).toBeNull();
      await page.waitForTimeout(TOAST_MOUNT_MS);
      // Read once: a retried count would pass once a duplicate has expired.
      expect(await toast(page, SUCCESS_TOAST).count()).toBe(1);
      expect(mints).toBe(1);
    } finally {
      await deleteCredential(apiClient, credentialId);
    }
  });

  test("a refused redeem is told once, by the modal that shows it", async ({
    authedPage: page,
  }) => {
    await page.goto(SETTINGS_PATH);
    const { token } = await openPairingModal(page);
    await helperRedeemRefused(page, token);

    const dialog = credentialDialog(page);
    await expect(dialog.getByText(PAIRING_FAILED)).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole("button", { name: REGENERATE_BUTTON })).toBeVisible();

    // The watcher drops the entry in the effect that would fire its toast.
    await expect.poll(() => readStore(page), { timeout: 15_000 }).toBeNull();
    await page.waitForTimeout(TOAST_MOUNT_MS);
    // Read once: `toHaveCount(0)` would wait the toast out and pass.
    expect(await toast(page, PAIRING_FAILED).count()).toBe(0);
  });

  test("a refused redeem is told by a toast once the modal is closed", async ({
    authedPage: page,
  }) => {
    await page.goto(SETTINGS_PATH);
    const { token } = await openPairingModal(page);
    await closePairingModal(page);
    await helperRedeemRefused(page, token);

    await expect(toast(page, PAIRING_FAILED)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => readStore(page), { timeout: 15_000 }).toBeNull();
  });
});
