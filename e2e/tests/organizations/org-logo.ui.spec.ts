// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";

for (const width of [1440, 390]) {
  test(`organization logo upload, replace, reload, emoji and removal at ${width}px`, async ({
    authedPage: page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await page.goto("/org-settings/general");
    const logo = page
      .getByRole("dialog", { name: "Paramètres", exact: true })
      .locator('img[src*="/logo?v="]');
    const upload = async (color: string) => {
      const base64 = await page.evaluate((fill) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const context = canvas.getContext("2d")!;
        context.fillStyle = fill;
        context.fillRect(0, 0, 16, 16);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }, color);
      await page.locator('input[type="file"]').setInputFiles({
        name: "logo.png",
        mimeType: "image/png",
        buffer: Buffer.from(base64, "base64"),
      });
      await expect(logo).toBeVisible();
      await expect
        .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);
      return logo.getAttribute("src");
    };
    const before = await upload("#2255cc");
    await upload("#cc5522");
    await expect(logo).not.toHaveAttribute("src", before!);
    const after = await logo.getAttribute("src");
    await page.reload();
    await expect(logo).toHaveAttribute("src", after!);
    await expect
      .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth > 0))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`organization-logo-${width}.png`) });
    await page.getByRole("button", { name: "Choisir un emoji", exact: true }).click();
    await page.getByRole("button", { name: "Utiliser 🧠 comme logo", exact: true }).click();
    await expect(logo).toHaveCount(0);
    await page.getByRole("button", { name: "Retirer", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retirer", exact: true })).toHaveCount(0);
  });
}
