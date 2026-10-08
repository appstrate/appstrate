// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only companions of `src/pi-payload.ts`: Pi's untouched records and the
 * full HTTP request Pi sends, for the runner-pi and api tests.
 */

import { Type, type ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { PAYLOAD_API_KEY } from "../src/pi-payload.ts";
import type { Api, Model } from "../src/pi-sdk.ts";

type Payload = Record<string, unknown>;

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
      { apiKey: PAYLOAD_API_KEY, maxTokens: 1_024, ...(reasoning ? { reasoning } : {}) },
    ).result();
  } finally {
    stub.stop(true);
  }
  if (!captured) throw new Error(`${model.provider}/${model.id}: no request sent`);
  return captured;
}
