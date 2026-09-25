// SPDX-License-Identifier: Apache-2.0

/**
 * Capture the request body Pi would put on the wire for a model, without a
 * network call: `onPayload` throws once the body is built.
 *
 * Lives in runner-pi — the package that declares `@earendil-works/pi-ai` — so
 * the api and sidecar tests compare payloads without importing the vendor.
 */

import { Type, type ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "../src/pi-sdk.ts";

type Payload = Record<string, unknown>;

// pi-ai reads the ChatGPT account id off a codex token's JWT claims.
const CODEX_TEST_TOKEN = `h.${btoa(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
)}.s`;

export async function capturePayload(
  model: Model<Api>,
  reasoning?: ThinkingLevel,
): Promise<Payload> {
  let payload: unknown;
  const result = await streamSimple(
    model,
    { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {
      apiKey: model.api === "openai-codex-responses" ? CODEX_TEST_TOKEN : "test-key",
      maxTokens: 4_096,
      ...(reasoning ? { reasoning } : {}),
      onPayload: (next: unknown) => {
        payload = next;
        throw new Error("payload captured");
      },
    },
  ).result();
  if (result.errorMessage !== "payload captured") {
    throw new Error(`${model.provider}/${model.id}: ${result.errorMessage}`);
  }
  return payload as Payload;
}

/** Pi's own registry record, untouched: what the vendor natively receives. */
export function nativeModel(provider: string, modelId: string): Model<Api> | undefined {
  return (getBuiltinModel as (p: string, m: string) => Model<Api> | undefined)(provider, modelId);
}

/**
 * The HTTP request Pi sends for a model (headers + body), with one tool
 * declared, captured by a local stub standing in for the vendor.
 */
export async function captureRequest(
  model: Model<Api>,
  reasoning?: ThinkingLevel,
): Promise<{ headers: Headers; body: Payload }> {
  let captured: { headers: Headers; body: Payload } | undefined;
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      captured = { headers: req.headers, body: (await req.json()) as Payload };
      return Response.json({ error: { message: "captured" } }, { status: 400 });
    },
  });
  try {
    await streamSimple(
      { ...model, baseUrl: `http://127.0.0.1:${stub.port}` },
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
        tools: [
          {
            name: "lookup",
            description: "Look up a value",
            parameters: Type.Object({ key: Type.String() }),
          },
        ],
      },
      { apiKey: "test-key", maxTokens: 1_024, ...(reasoning ? { reasoning } : {}) },
    ).result();
  } finally {
    stub.stop(true);
  }
  if (!captured) throw new Error(`${model.provider}/${model.id}: no request sent`);
  return captured;
}
