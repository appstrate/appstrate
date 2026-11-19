// SPDX-License-Identifier: Apache-2.0

/**
 * A local OpenAI-compatible model for the chat specs: a stub server streaming one reply, wired
 * as an org credential + model. Nothing reaches a real provider.
 */

import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import type { ApiClient } from "./api-client.ts";

interface ChatCompletionBody {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}

export interface LocalChatModel {
  /** The model's id, as the picker lists it. */
  modelId: string;
  /** The org model preset's id (`PATCH /api/models/{id}`). */
  presetId: string;
}

/** Runs `run` with the stub model registered; the stub is closed afterwards. */
export async function withLocalChatModel<T>(
  apiClient: Pick<ApiClient, "post">,
  options: {
    modelId: string;
    input: Array<"text" | "image">;
    /** The assistant's reply to a request; receives the parsed Chat Completions body. */
    reply: (body: ChatCompletionBody) => string;
  },
  run: (model: LocalChatModel) => Promise<T>,
): Promise<T> {
  const { modelId, input, reply } = options;
  const key = "local-e2e-fixture";
  const provider = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions" || req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const content = reply(JSON.parse(Buffer.concat(chunks).toString()) as ChatCompletionBody);
    const frame = {
      id: "e2e-chat",
      model: modelId,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
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
      input,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    expect(model.status()).toBe(201);
    return await run({ modelId, presetId: (await model.json()).id });
  } finally {
    await new Promise<void>((resolve, reject) =>
      provider.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

/** Selects the model in the composer's picker. */
export async function pickModel(page: Page, modelId: string): Promise<void> {
  await page.getByTitle("Modèle et génération").click();
  await page.getByRole("option", { name: new RegExp(modelId) }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTitle("Modèle et génération")).toHaveText(modelId);
}
