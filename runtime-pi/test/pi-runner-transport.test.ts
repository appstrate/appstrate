// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiModelConfig } from "@appstrate/runner-pi";
import { createApp, type AppDeps } from "../sidecar/app.ts";
import { parseRuntimeEnv } from "../env.ts";
import { buildRuntimeModel } from "../model.ts";
import { createRuntimePiRunner } from "../pi-runner.ts";
import {
  createCaptureSink,
  makeBundlePackage,
  makeContext,
  makeTestBundle,
} from "../../packages/runner-pi/test/helpers.ts";

interface ObservedRequest {
  method: string;
  path: string;
}

interface OpenAiCompatibleRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  thinking?: { type?: string };
}

const TEST_JWT = [
  encodeJwtSegment({ alg: "none", typ: "JWT" }),
  encodeJwtSegment({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  }),
  "placeholder",
].join(".");

const TEST_BUNDLE = makeTestBundle(
  makeBundlePackage("@test/runtime-sidecar-transport", "0.0.0", "agent", {}),
);

function encodeJwtSegment(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function completedResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
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
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function completedChatResponse(model: string): Response {
  const chunks = [
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_test",
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

describe("runtime-pi sidecar transport wiring", () => {
  it("uses one SSE POST through the sidecar and finalizes successfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-transport-"));
    const agentDir = join(root, "agent");
    const sidecarRequests: ObservedRequest[] = [];
    const upstreamRequests: ObservedRequest[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
      await mkdir(agentDir, { recursive: true });
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(typeof input === "string" ? input : input.href);
        upstreamRequests.push({
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          path: url.pathname,
        });
        return completedResponse();
      }) as unknown as typeof fetch;
      const deps: AppDeps = {
        config: {
          platformApiUrl: "http://mock:3000",
          runToken: "tok",
          proxyUrl: "",
          llm: {
            authMode: "api_key",
            baseUrl: "https://upstream.example",
            apiKey: "real-key",
            placeholder: TEST_JWT,
          },
        },
        cookieJar: new Map(),
        fetchFn,
      };
      const app = createApp(deps);
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          sidecarRequests.push({
            method: request.method,
            path: new URL(request.url).pathname,
          });
          return app.fetch(request);
        },
      });

      const model: PiModelConfig = {
        id: "gpt-5-codex",
        name: "gpt-5-codex",
        api: "openai-codex-responses",
        provider: "openai",
        baseUrl: `${server.url.origin}/llm`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      };
      const sink = createCaptureSink();
      const runner = createRuntimePiRunner({
        sidecarUrl: server.url.origin,
        model,
        apiKey: TEST_JWT,
        systemPrompt: "Answer briefly.",
        startMessage: "Say done.",
        cwd: root,
        agentDir,
        authStoragePath: join(root, "auth.json"),
      });

      await runner.run({
        bundle: TEST_BUNDLE,
        context: makeContext(),
        eventSink: sink,
      });

      expect(sidecarRequests).toEqual([{ method: "POST", path: "/llm/codex/responses" }]);
      expect(upstreamRequests).toEqual([{ method: "POST", path: "/codex/responses" }]);
      expect(sink.finalizeCalls).toBe(1);
      expect(sink.finalized?.status).toBe("success");
    } finally {
      if (server) await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves DeepSeek compatibility through an aliased sidecar run", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-deepseek-"));
    const agentDir = join(root, "agent");
    const requests: OpenAiCompatibleRequest[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
      await mkdir(agentDir, { recursive: true });
      const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body ?? "");
        const parsed = JSON.parse(body) as OpenAiCompatibleRequest;
        requests.push(parsed);
        if (parsed.messages?.some((message) => message.role === "developer")) {
          return Response.json(
            { error: { message: "Unsupported message role: developer" } },
            { status: 400 },
          );
        }
        return completedChatResponse("deepseek-v4-flash");
      }) as unknown as typeof fetch;
      const app = createApp({
        config: {
          platformApiUrl: "http://mock:3000",
          runToken: "tok",
          proxyUrl: "",
          llm: {
            authMode: "api_key",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "real-key",
            placeholder: "canary-placeholder",
            modelSwap: { alias: "appstrate-flash", real: "deepseek-v4-flash" },
          },
        },
        cookieJar: new Map(),
        fetchFn,
      });
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });

      const model = buildRuntimeModel(
        parseRuntimeEnv({
          AGENT_RUN_ID: "run_deepseek_canary",
          APPSTRATE_SINK_URL: "https://api.example.com/events",
          APPSTRATE_SINK_FINALIZE_URL: "https://api.example.com/events/finalize",
          APPSTRATE_SINK_SECRET: "abcdefghijklmnopqrstuvwxyz0123456789",
          AGENT_PROMPT: "Answer briefly.",
          MODEL_API: "openai-completions",
          MODEL_PROVIDER: "deepseek",
          MODEL_ID: "appstrate-flash",
          MODEL_BASE_URL: `${server.url.origin}/llm`,
          MODEL_REASONING: "true",
          MODEL_CONTEXT_WINDOW: "131072",
          MODEL_MAX_TOKENS: "16",
        }),
      );
      const sink = createCaptureSink();
      const runner = createRuntimePiRunner({
        sidecarUrl: server.url.origin,
        model,
        apiKey: "canary-placeholder",
        systemPrompt: "Answer briefly.",
        startMessage: "Reply OK.",
        cwd: root,
        agentDir,
        authStoragePath: join(root, "auth.json"),
      });

      await runner.run({ bundle: TEST_BUNDLE, context: makeContext(), eventSink: sink });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.model).toBe("deepseek-v4-flash");
      expect(requests[0]?.messages?.[0]?.role).toBe("system");
      expect(requests[0]?.messages?.some((message) => message.role === "developer")).toBe(false);
      expect(requests[0]?.thinking).toEqual({ type: "enabled" });
      expect(sink.finalized?.status).toBe("success");
    } finally {
      if (server) await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});
