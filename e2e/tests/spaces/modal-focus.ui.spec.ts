// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSkill } from "../../helpers/seed.ts";
import { PackageEditorPage } from "../../pages/package-editor-page.ts";

test("a state dialog returns keyboard focus to its opener after Escape and Cancel", async ({
  authedPage: page,
}, testInfo) => {
  await page.goto("/schedules");
  const opener = page.getByRole("button", { name: "Nouvelle planification", exact: true });
  await expect(opener).toBeVisible();
  await opener.focus();
  for (const close of ["Escape", "Cancel"]) {
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    if (close === "Escape") await page.keyboard.press("Escape");
    else
      await page.getByRole("dialog").getByRole("button", { name: "Annuler", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
  await page.screenshot({ path: testInfo.outputPath("modal-focus-restored.png") });
});

test("a confirmation returns keyboard focus to its opener on Cancel", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `focus-files-${Date.now()}`;
  await createSkill(apiClient, scope, name);
  const editor = new PackageEditorPage(page, scope, name);
  await editor.goto();
  await editor.createFile("notes.txt");
  const opener = editor.fileRow("notes.txt");
  await opener.focus();
  await page.keyboard.press("Delete");
  await expect(editor.confirmDialog).toBeVisible();
  await editor.confirmDialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(editor.confirmDialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
