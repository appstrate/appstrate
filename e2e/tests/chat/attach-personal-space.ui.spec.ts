// SPDX-License-Identifier: Apache-2.0

/**
 * A file dropped into the chat from « Tous les espaces », where the member acts in several team
 * spaces, is staged in their personal space (« Mon espace »): no space question, and the file
 * is listed there once the turn has materialized it. The model is a local OpenAI-compatible stub.
 */

import { createServer } from "node:http";
import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSpace } from "../../helpers/seed.ts";
import { createOverviewContext } from "../../helpers/overview.ts";

interface SpaceDto {
  id: string;
  personal: boolean;
  access: "member" | "none";
}

test("a drop in « Tous les espaces » stages the file in the personal space", async ({
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  test.slow();
  const { orgId, defaultSpaceId } = browserCtx.org;
  await createSpace(orgOnlyClient, `Alpha ${Date.now()}`);
  await createSpace(orgOnlyClient, `Beta ${Date.now()}`);
  const spaces = (await (await orgOnlyClient.get("/spaces")).json()) as { data: SpaceDto[] };
  const personal = spaces.data.find((space) => space.personal && space.access === "member");
  expect(personal).toBeDefined();

  const modelId = "local-chat-text";
  const key = "local-e2e-fixture";
  const answer = "Fichier reçu.";
  const provider = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions" || req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(404).end();
      return;
    }
    for await (const _ of req);
    const frame = {
      id: "e2e-chat",
      model: modelId,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
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
  const context = await createOverviewContext(browser, browserCtx.auth, orgId, defaultSpaceId);
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
      input: ["text"],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    expect(model.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/chat");
    const message = page.getByPlaceholder("Message Appstrate…");
    await expect(message).toBeVisible();
    // The attach button is usable at once: no space to choose.
    await expect(
      page.getByRole("button", { name: "Joindre des fichiers", exact: true }),
    ).toBeEnabled();

    // A real drop on the thread: a DataTransfer carrying the file, dispatched on the dropzone.
    const dropzone = message.locator("xpath=ancestor::div[contains(@class,'group/drop')]");
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["Bonjour"], "depose.txt", { type: "text/plain" }));
      return data;
    });
    await dropzone.dispatchEvent("dragenter", { dataTransfer: transfer });
    await dropzone.dispatchEvent("dragover", { dataTransfer: transfer });
    await dropzone.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(page.getByText("depose.txt", { exact: true })).toBeVisible();

    const upload = page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/uploads",
    );
    await message.fill("Voici le fichier.");
    await page.getByRole("button", { name: "Envoyer", exact: true }).click();
    const response = await upload;
    expect(response.ok()).toBe(true);
    expect(await response.request().headerValue("X-Space-Id")).toBe(personal!.id);
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(page.getByText("depose.txt", { exact: true })).toBeVisible();

    // The turn materialized the upload: the file is listed in « Mon espace ».
    await expect
      .poll(async () => {
        const listed = await apiClient.withSpace(personal!.id).get("/files");
        return JSON.stringify(await listed.json());
      })
      .toContain("depose.txt");
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) =>
      provider.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
