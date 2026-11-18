// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { pickModel, withLocalChatModel } from "../../helpers/chat-model.ts";

test("sends image pixels to the configured provider and reloads the attached files by reference", async ({
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
  const answer = "Image reçue. PDF à examiner dans un run.";
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
      text.includes("appfile://") &&
      text.includes("does not accept PDF input") &&
      !text.includes(pdf.toString("base64"));
    return received ? answer : "Unexpected attachment input";
  };
  await withLocalChatModel(
    apiClient,
    { modelId, input: ["text", "image"], reply },
    async (model) => {
      await page.goto("/chat");
      await pickModel(page, modelId);
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
      // A Chat Completions model reads no PDF natively: the chip says so before anything is sent.
      await expect(page.getByText("Ce modèle ne lit pas les PDF.")).toBeVisible();
      await page.getByPlaceholder("Message Appstrate…").fill("Peux-tu lire ces deux fichiers ?");
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
      await (await nextFile).setFiles({ name: "draft.png", mimeType: "image/png", buffer: png });
      await expect(page.getByText("Ce modèle ne peut pas voir l’image.")).toBeVisible();
    },
  );
});
