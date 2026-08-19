// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRunner, type PiModelConfig, type Transport } from "../src/index.ts";
import { createCaptureSink, makeBundlePackage, makeContext, makeTestBundle } from "./helpers.ts";

const TEST_JWT = [
  encodeJwtSegment({ alg: "none", typ: "JWT" }),
  encodeJwtSegment({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  }),
  "placeholder",
].join(".");

const TEST_BUNDLE = makeTestBundle(
  makeBundlePackage("@test/codex-transport", "0.0.0", "agent", {}),
);

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
  const root = await mkdtemp(join(tmpdir(), "runner-pi-transport-"));
  const agentDir = join(root, "agent");
  const methods: string[] = [];
  const paths: string[] = [];
  const upgrades: Array<string | null> = [];
  const accepts: Array<string | null> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    await mkdir(agentDir, { recursive: true });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        methods.push(request.method);
        paths.push(new URL(request.url).pathname);
        upgrades.push(request.headers.get("upgrade"));
        accepts.push(request.headers.get("accept"));
        if (request.method === "POST") return completedResponse();
        return new Response("Method Not Allowed", { status: 405 });
      },
    });

    const model: PiModelConfig = {
      id: "gpt-5-codex",
      name: "gpt-5-codex",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: server.url.origin,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    };
    const sink = createCaptureSink();
    const runner = new PiRunner({
      model,
      apiKey: TEST_JWT,
      systemPrompt: "Answer briefly.",
      startMessage: "Say done.",
      cwd: root,
      agentDir,
      authStoragePath: join(root, "auth.json"),
      ...(transport ? { transport } : {}),
    });

    await runner.run({
      bundle: TEST_BUNDLE,
      context: makeContext(),
      eventSink: sink,
    });

    expect(sink.finalizeCalls).toBe(1);
    return {
      methods,
      paths,
      upgrades,
      accepts,
      status: sink.finalized?.status,
    };
  } finally {
    if (server) await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
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
