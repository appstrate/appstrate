// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { runModelRuntimeCanary, type ModelRuntimeCanaryTarget } from "../model-canary.ts";

const TARGET: ModelRuntimeCanaryTarget = {
  id: "appstrate-flash",
  providerId: "deepseek",
  apiShape: "openai-completions",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "real-key",
  modelId: "deepseek-v4-flash",
  aliased: true,
  reasoning: true,
  input: ["text"],
  contextWindow: 131_072,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function chatResponse(model: string): Response {
  const chunks = [
    {
      id: "chatcmpl_canary",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_canary",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("runModelRuntimeCanary", () => {
  it("runs the effective aliased model through Pi and the sidecar", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const result = await runModelRuntimeCanary(TARGET, {
      fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return chatResponse(TARGET.modelId);
      }) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe(TARGET.modelId);
    expect(bodies[0]?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system" })]),
    );
    expect(bodies[0]?.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "developer" })]),
    );
    expect(bodies[0]?.max_completion_tokens).toBe(16);
  });

  it("fails a deterministic provider rejection without retrying or falling back", async () => {
    let calls = 0;
    const result = await runModelRuntimeCanary(TARGET, {
      fetchFn: (async () => {
        calls++;
        return Response.json(
          { error: { message: "Unsupported message role: developer" } },
          { status: 400 },
        );
      }) as unknown as typeof fetch,
    });

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("400");
  });
});
