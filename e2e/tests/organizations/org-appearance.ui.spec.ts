// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's appearance, end to end: each pick in the settings'
 * `AppearancePicker` is read back from the wire, then from the switcher's tile
 * after a reload — the tile every member sees.
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
    // The org's tile is the trigger's first; the current space's follows it.
    const tile = new Sidebar(page).switcherButton.locator('[class*="@container"]').first();

    await page.goto("/org-settings/general");

    // Image: drawn by the canvas the old logo spec used, encoded to WebP by the picker.
    await settings.getByRole("radio", { name: "Image", exact: true }).click();
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
    await page.reload();
    await expect(tile.locator("img")).toHaveAttribute("src", image);
    await expect
      .poll(() => tile.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth > 0))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`organization-appearance-${width}.png`) });

    // Emoji: the first one the picker lists, whichever it is, read back as written.
    await settings.getByRole("radio", { name: "Emoji", exact: true }).click();
    await settings.getByRole("button", { name: "Choisir un emoji" }).click();
    const firstEmoji = page.locator("[frimousse-emoji]").first();
    await expect(firstEmoji).toBeVisible();
    const emoji = (await firstEmoji.textContent())!;
    await firstEmoji.click();
    await expect.poll(async () => (await stored()).icon).toBe(`emoji:${emoji}`);
    await page.reload();
    await expect(tile).toHaveText(emoji);

    // Colour: a palette key, drawn as the tile's tint.
    await settings.getByTitle("Violet", { exact: true }).click();
    await expect.poll(async () => (await stored()).color).toBe("violet");
    await page.reload();
    await expect(tile).toHaveClass(/text-identity-violet/);

    // Removing the icon leaves the initials on the chosen colour.
    await settings.getByRole("button", { name: "Retirer l’icône", exact: true }).click();
    await expect.poll(stored).toEqual({ icon: null, color: "violet" });
    await page.reload();
    const words = orgName.split(/\s+/);
    await expect(tile).toHaveText(`${words[0]![0]}${words[1]![0]}`.toUpperCase());
    await expect(tile).toHaveClass(/text-identity-violet/);
  });
}
