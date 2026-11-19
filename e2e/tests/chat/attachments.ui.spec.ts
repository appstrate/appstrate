// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { test, expect } from "../../fixtures/browser.fixture.ts";

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
  const key = "local-e2e-fixture";
  const provider = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions" || req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const content = body.messages.findLast(
      (message: { role: string }) => message.role === "user",
    )?.content;
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
    const frame = {
      id: "e2e-chat",
      model: modelId,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: received ? answer : "Unexpected attachment input" },
          finish_reason: null,
        },
      ],
    };
    const end = {
      ...frame,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    };
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(`data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Expected local provider port");
    const credential = await apiClient.post("/model-provider-credentials", {
      providerId: "openai-compatible",
      api_key: key,
      base_url_override: `http://127.0.0.1:${address.port}/v1`,
    });
    expect(credential.status()).toBe(201);
    const model = await apiClient.post("/models", {
      modelId,
      credentialId: (await credential.json()).id,
      input: ["text", "image"],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    expect(model.status()).toBe(201);
    const preset = await model.json();
    await page.goto("/chat");
    await page.getByTitle("Modèle et génération").click();
    await page.getByRole("option", { name: new RegExp(modelId) }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTitle("Modèle et génération")).toHaveText(modelId);
    await expect(
      page.getByRole("textbox", { name: "Message Appstrate…", exact: true }),
    ).toHaveAttribute("placeholder", new RegExp(modelId));
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
    await page
      .getByRole("textbox", { name: "Message Appstrate…", exact: true })
      .fill("Peux-tu lire ces deux fichiers ?");
    await page.getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/chat\/[^/]+$/);

    const sessionId = new URL(page.url()).pathname.split("/").at(-1);
    const session = await apiClient.get(`/orgs/${browserCtx.org.orgId}/chat/sessions/${sessionId}`);
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
    const textOnly = await apiClient.patch(`/models/${preset.id}`, { input: ["text"] });
    expect(textOnly.ok()).toBe(true);
    await page.reload();
    const nextFile = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: /^Joindre des fichiers/ }).click();
    await (await nextFile).setFiles({ name: "draft.png", mimeType: "image/png", buffer: png });
    await expect(page.getByText("Ce modèle ne peut pas voir l’image.")).toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) =>
      provider.close((err) => (err ? reject(err) : resolve())),
    );
  }
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
