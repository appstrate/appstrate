// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { PiModelConfig } from "../src/index.ts";
// `Transport` is an in-package type: the barrel stopped re-exporting it when
// #1173 removed its only out-of-package consumer, so this test reads it from
// the SDK import surface directly (the `no-restricted-imports` guard allows
// `pi-sdk.ts`, not the vendor package).
import type { Transport } from "../src/pi-sdk.ts";
import { runAgainstStub } from "./helpers.ts";

const TEST_JWT = [
  encodeJwtSegment({ alg: "none", typ: "JWT" }),
  encodeJwtSegment({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  }),
  "placeholder",
].join(".");

function encodeJwtSegment(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function completedResponse(): Response {
  const event = {
    type: "response.completed",
    response: {
      id: "resp_test",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        total_tokens: 2,
      },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function runAgainstLocalCodex(transport?: Transport): Promise<{
  methods: string[];
  paths: string[];
  upgrades: Array<string | null>;
  accepts: Array<string | null>;
  status: string | undefined;
}> {
  const { requests, sink } = await runAgainstStub({
    model: (origin): PiModelConfig => ({
      id: "gpt-5-codex",
      name: "gpt-5-codex",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: origin,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    }),
    respond: (request) =>
      request.method === "POST"
        ? completedResponse()
        : new Response("Method Not Allowed", { status: 405 }),
    runner: { apiKey: TEST_JWT, ...(transport ? { transport } : {}) },
  });

  expect(sink.finalizeCalls).toBe(1);
  return {
    methods: requests.map((request) => request.method),
    paths: requests.map((request) => request.path),
    upgrades: requests.map((request) => request.headers.get("upgrade")),
    accepts: requests.map((request) => request.headers.get("accept")),
    status: sink.finalized?.status,
  };
}

describe("PiRunner provider transport", () => {
  it("keeps the direct auto default and falls back to SSE when WebSocket is unavailable", async () => {
    const result = await runAgainstLocalCodex();

    expect(result.methods).toEqual(["GET", "POST"]);
    expect(result.paths).toEqual(["/codex/responses", "/codex/responses"]);
    expect(result.upgrades).toEqual(["websocket", null]);
    expect(result.accepts[1]).toBe("text/event-stream");
    expect(result.status).toBe("success");
  });

  it("uses SSE directly and finalizes successfully when requested", async () => {
    const result = await runAgainstLocalCodex("sse");

    expect(result.methods).toEqual(["POST"]);
    expect(result.paths).toEqual(["/codex/responses"]);
    expect(result.upgrades).toEqual([null]);
    expect(result.accepts).toEqual(["text/event-stream"]);
    expect(result.status).toBe("success");
  });
});
