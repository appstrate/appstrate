// SPDX-License-Identifier: Apache-2.0

/**
 * Capture the request body Pi would put on the wire for a model, without a
 * network call: `onPayload` throws once the body is built.
 *
 * Lives in runner-pi — the package that declares `@earendil-works/pi-ai` — so
 * the model-catalog build and the api tests compare payloads without importing
 * the vendor.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { piModelDialect } from "./pi-model.ts";
import type { Api, Model } from "./pi-sdk.ts";

type Payload = Record<string, unknown>;

// Shaped like a plain API key: pi-ai reads any other credential sent to
// `api.openai.com` as a ChatGPT sign-in and shapes the request for it.
export const PAYLOAD_API_KEY = "sk-test-key";

// pi-ai reads the ChatGPT account id off a codex token's JWT claims.
const CODEX_PAYLOAD_TOKEN = `h.${btoa(
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
      apiKey: model.api === "openai-codex-responses" ? CODEX_PAYLOAD_TOKEN : PAYLOAD_API_KEY,
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

/** A registry record as the platform resolves it for a builder: its dialect and its own values. */
export function recordSpec(record: Model<Api>) {
  return {
    dialect: piModelDialect(record),
    reasoning: record.reasoning,
    input: record.input,
    cost: record.cost,
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
  };
}
