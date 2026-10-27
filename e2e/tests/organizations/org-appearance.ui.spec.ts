// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's appearance, end to end: each pick in the settings'
 * `AppearancePicker` is read back from the wire, then from the switcher's tile
 * on a fresh load of the shell — the tile every member sees.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { Sidebar } from "../../pages/sidebar.ts";

for (const width of [1440, 390]) {
  test(`organization appearance: image, emoji, colour and removal at ${width}px`, async ({
    authedPage: page,
    orgOnlyClient,
    browserCtx,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    const { orgId, orgName } = browserCtx.org;
    const stored = async () => {
      const res = await orgOnlyClient.get(`/orgs/${orgId}`);
      expect(res.status()).toBe(200);
      const org = await res.json();
      return { icon: org.icon as string | null, color: org.color as string | null };
    };
    const settings = page.getByRole("dialog", { name: "Paramètres", exact: true });
    const openSettings = async () => {
      await page.goto("/org-settings/general");
      await expect(settings).toBeVisible();
    };
    /**
     * The org's tile in the shell, on a fresh load. On a phone the header names
     * the page's trail, not the organization, so the switcher is the sidebar's,
     * behind the menu button. The org's tile is the trigger's first; the
     * current space's follows it.
     */
    const shellTile = async () => {
      await page.goto("/");
      if (width === 390) {
        await page.getByRole("button", { name: "Afficher ou masquer le menu latéral" }).click();
        await expect(page.getByRole("dialog", { name: "Menu latéral", exact: true })).toBeVisible();
      }
      return new Sidebar(page).switcherButton.locator('[class*="@container"]').first();
    };
    const colourNote = settings.getByText(
      "La couleur s’affiche derrière une icône ou un emoji, pas sous une image.",
      { exact: true },
    );

    await openSettings();

    // Image: drawn by the canvas the old logo spec used, encoded to WebP by the picker.
    await settings.getByRole("tab", { name: "Image", exact: true }).click();
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 16;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#2255cc";
      context.fillRect(0, 0, 16, 16);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    await settings.locator('input[type="file"]').setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: Buffer.from(base64, "base64"),
    });
    await expect.poll(async () => (await stored()).icon).toMatch(/^data:image\/webp;base64,/);
    const image = (await stored()).icon!;
    // An image covers the tile: the picker says the colour is not drawn under it.
    await expect(colourNote).toBeVisible();
    let tile = await shellTile();
    // The avatar mounts its <img> only once the image has loaded, so its presence is the load.
    await expect(tile.locator("img")).toHaveAttribute("src", image);
    await expect
      .poll(() => tile.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth > 0))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`organization-appearance-${width}.png`) });

    // Emoji: picked by its French name. Emojibase writes 👍 with U+FE0F; the
    // server stores the RGI form, which this emoji takes without it.
    await openSettings();
    await settings.getByRole("tab", { name: "Emoji", exact: true }).click();
    await settings.getByRole("button", { name: "Choisir un emoji", exact: true }).click();
    await page.getByPlaceholder("Rechercher un emoji…", { exact: true }).fill("pouce");
    await page.getByRole("gridcell", { name: /^pouce vers le haut$/i }).click();
    await expect.poll(async () => (await stored()).icon).toBe("emoji:\u{1F44D}");
    await expect(settings.getByRole("button", { name: /Changer d’emoji/ })).toBeVisible();
    await expect(colourNote).toHaveCount(0);
    tile = await shellTile();
    await expect(tile).toHaveText("\u{1F44D}");

    // Colour: a palette key, drawn as the tile's tint.
    await openSettings();
    await settings.getByTitle("Violet", { exact: true }).click();
    await expect.poll(async () => (await stored()).color).toBe("violet");
    tile = await shellTile();
    await expect(tile).toHaveClass(/text-identity-violet/);

    // Removing the icon leaves the initials on the chosen colour.
    await openSettings();
    await settings.getByRole("button", { name: "Retirer l’icône", exact: true }).click();
    await expect.poll(stored).toEqual({ icon: null, color: "violet" });
    tile = await shellTile();
    // The first letters of the first and the last word (`E2E Org <tag>`).
    const words = orgName.split(/\s+/);
    await expect(tile).toHaveText(`${words[0]![0]}${words.at(-1)![0]}`.toUpperCase());
    await expect(tile).toHaveClass(/text-identity-violet/);
  });
}
