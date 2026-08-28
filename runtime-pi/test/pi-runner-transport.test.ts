// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiModelConfig } from "@appstrate/runner-pi";
import { SIDECAR_AUTH_HEADER } from "@appstrate/core/sidecar-types";
import { createApp, type AppDeps } from "../sidecar/app.ts";
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

const SIDECAR_AUTH_TOKEN = "transport-test-sidecar-token";

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
          sidecarAuthToken: SIDECAR_AUTH_TOKEN,
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
        provider: "openai-codex",
        baseUrl: `${server.url.origin}/llm`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
        // Exactly what `buildPiModelFromEnv` puts on the model in-container.
        // This is the ONLY thing carrying the agent's credential onto the
        // `/llm/*` leg, and it has to survive pi-ai's own header assembly —
        // which is why this end-to-end wiring test is where it is asserted.
        headers: { [SIDECAR_AUTH_HEADER]: SIDECAR_AUTH_TOKEN },
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
      // Reached the handler at all ⇒ `Model.headers` carried the auth token
      // through pi-ai to the sidecar; the control surface denies by default.
      expect(upstreamRequests).toEqual([{ method: "POST", path: "/codex/responses" }]);
      expect(sink.finalizeCalls).toBe(1);
      expect(sink.finalized?.status).toBe("success");
    } finally {
      if (server) await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});
