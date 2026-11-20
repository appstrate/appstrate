// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { pickModel, withLocalChatModel } from "../../helpers/chat-model.ts";

test("sends image pixels and the PDF to the configured provider and reloads the attached files by reference", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  test.slow();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const pdf = Buffer.from("%PDF-1.7\nChat PDF fixture");
  const answer = "Image et PDF reçus.";
  const modelId = "local-chat-vision";
  const reply = (body: { model: string; messages: Array<{ role: string; content: unknown }> }) => {
    const content = body.messages.findLast((message) => message.role === "user")?.content;
    const text = JSON.stringify(content);
    const received =
      body.model === modelId &&
      Array.isArray(content) &&
      content.some(
        (part) =>
          part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,iVBOR"),
      ) &&
      content.some(
        (part) =>
          part.type === "file" &&
          part.file.filename === "contract.pdf" &&
          part.file.file_data === `data:application/pdf;base64,${pdf.toString("base64")}`,
      ) &&
      text.includes("appfile://") &&
      // The one-turn reference is swapped for the file and never reaches the provider.
      !text.includes("[pdf:");
    return received ? answer : "Unexpected attachment input";
  };
  await withLocalChatModel(
    apiClient,
    { modelId, input: ["text", "image"], reply },
    async (model) => {
      await page.goto("/chat");
      await pickModel(page, modelId);
      const message = page.getByRole("textbox", { name: "Message Appstrate…", exact: true });
      await expect(message).toHaveAttribute("placeholder", new RegExp(modelId));
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: /^Joindre des fichiers/ }).click();
      await (
        await choosing
      ).setFiles([
        { name: "pixel.png", mimeType: "image/png", buffer: png },
        { name: "contract.pdf", mimeType: "application/pdf", buffer: pdf },
      ]);
      await expect(
        page.getByRole("button", { name: "Aperçu de pixel.png", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("contract.pdf", { exact: true })).toBeVisible();
      // A Chat Completions model with vision is sent the PDF: the chip warns about nothing.
      await expect(page.getByText("PDF non envoyé à ce modèle.")).toHaveCount(0);
      await message.fill("Peux-tu lire ces deux fichiers ?");
      await page.getByRole("button", { name: "Envoyer", exact: true }).click();
      await expect(page.getByText(answer, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/chat\/[^/]+$/);

      const sessionId = new URL(page.url()).pathname.split("/").at(-1);
      const session = await apiClient.get(
        `/orgs/${browserCtx.org.orgId}/chat/sessions/${sessionId}`,
      );
      expect(session.status()).toBe(200);
      const history = await session.text();
      expect(history).toContain("appfile://");
      expect(history).not.toContain("data:image/");
      expect(history).not.toContain(png.toString("base64"));
      expect(history).not.toContain(pdf.toString("base64"));
      expect(history).not.toContain("[pdf:");
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Aperçu de pixel.png", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("contract.pdf", { exact: true })).toBeVisible();
      await expect(page.getByText(answer, { exact: true })).toBeVisible();

      // A subsequent draft uses the updated model capabilities before the user sends.
      const textOnly = await apiClient.patch(`/models/${model.presetId}`, { input: ["text"] });
      expect(textOnly.ok()).toBe(true);
      await page.reload();
      const nextFile = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: /^Joindre des fichiers/ }).click();
      await (
        await nextFile
      ).setFiles([
        { name: "draft.png", mimeType: "image/png", buffer: png },
        { name: "draft.pdf", mimeType: "application/pdf", buffer: pdf },
      ]);
      await expect(page.getByText("Image non envoyée à ce modèle.")).toBeVisible();
      await expect(page.getByText("PDF non envoyé à ce modèle.")).toBeVisible();
    },
  );
});

test.describe("staged attachment touch targets", () => {
  test.use({ hasTouch: true });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 844, height: 390 },
  ]) {
    test(`tapping size previews and tapping remove only removes at ${viewport.width}px`, async ({
      authedPage: page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/chat");
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: /^Joindre des fichiers/ }).tap();
      const contents = "Compte rendu de la réunion.";
      await (
        await choosing
      ).setFiles([
        { name: "compte-rendu.txt", mimeType: "text/plain", buffer: Buffer.from(contents) },
        {
          name: "présentation.pptx",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("Office fixture"),
        },
      ]);
      const preview = page.getByRole("button", { name: "Aperçu de compte-rendu.txt" });
      const chip = preview.locator("..");
      const remove = chip.getByRole("button", { name: "Retirer la pièce jointe" });
      const office = page.getByText("présentation.pptx", { exact: true });
      await expect(office.locator("..").locator("svg.lucide-presentation")).toBeVisible();
      await office.tap();
      await expect(page.getByRole("button", { name: "Aperçu de présentation.pptx" })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("button", { name: "Replier le contexte de la conversation", exact: true }),
      ).toBeHidden();
      await preview.focus();
      await page.keyboard.press("Tab");
      await expect(remove).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(preview).toBeFocused();
      await expect(remove).toHaveCSS("width", "40px");
      await expect(remove).toHaveCSS("height", "40px");
      await page.screenshot({
        path: testInfo.outputPath("attachments.png"),
        animations: "disabled",
      });
      await preview.getByText(/\d+ o$/).tap();
      await expect(page.getByText(contents, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("preview.png"), animations: "disabled" });
      await page
        .getByRole("button", { name: "Replier le contexte de la conversation", exact: true })
        .last()
        .tap();
      await expect(preview).toBeVisible();
      await remove.tap();
      await expect(preview).toHaveCount(0);
      await expect(page.getByText(contents, { exact: true })).toBeHidden();
      await expect(office).toBeVisible();
    });
  }
});
