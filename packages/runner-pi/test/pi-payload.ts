// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only companions of `src/pi-payload.ts`: Pi's untouched records and the
 * full HTTP request Pi sends, for the runner-pi and api tests.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { unsafe } from "@earendil-works/pi-schema";
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
 * declared, captured at the SDK HTTP transport boundary.
 */
export async function captureRequest(
  model: Model<Api>,
  reasoning?: ThinkingLevel,
): Promise<{ headers: Headers; body: Payload }> {
  let captured: { headers: Headers; body: Payload } | undefined;
  const captureFetch: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const req =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      captured = { headers: req.headers, body: (await req.json()) as Payload };
      return Response.json({ error: { message: "captured" } }, { status: 400 });
    },
    {
      preconnect() {
        /* This capture transport has no socket. */
      },
    },
  );
  const result = await streamSimple(
    { ...model, baseUrl: "http://127.0.0.1:1" },
    {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          // The exact JSON TypeBox's `Type.Object({ key: Type.String() })`
          // emitted before Pi 1.5 dropped `Type`: pi-schema's `obj()` would
          // add `additionalProperties: false` and move the captured payload.
          parameters: unsafe({
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          }),
        },
      ],
    },
    {
      apiKey: PAYLOAD_API_KEY,
      maxTokens: 1_024,
      fetch: captureFetch,
      ...(reasoning ? { reasoning } : {}),
    },
  ).result();
  if (!captured)
    throw new Error(
      `${model.provider}/${model.id}: ${result.errorMessage ?? "no HTTP request sent"}`,
    );
  return captured;
}
