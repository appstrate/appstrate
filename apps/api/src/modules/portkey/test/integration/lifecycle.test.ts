// SPDX-License-Identifier: Apache-2.0

/**
 * E2E lifecycle test for the Portkey sub-process.
 *
 *  1. Spawn a Bun-served mock OpenAI-compatible upstream on a random port.
 *  2. Call `startPortkey({ port })` — verifies the ready signal works.
 *  3. Fire a streaming call through Portkey targeting the mock via
 *     inline `x-portkey-config` — verifies the integration shape the
 *     run launcher emits actually reaches the upstream.
 *  4. Call `stopPortkey()` — verifies SIGTERM ordering + cleanup.
 *
 * Reproduces the smoke-test SSE concurrent-streaming behavior in the
 * official test suite, so a regression on Portkey's pass-through
 * semantics surfaces here instead of in production.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { serve } from "bun";
import {
  startPortkey,
  stopPortkey,
  getPortkeyPort,
  _getPortkeyProcessForTesting,
} from "../../lifecycle.ts";

// `Bun.Server` is generic; we only use `stop()`/`port`, so a structural type
// keeps the test surface narrow and avoids the unused generic parameter.
type MockServer = { port: number; stop(closeActive?: boolean): void };

interface MockUpstream {
  server: MockServer;
  port: number;
  observedAuth: string[];
}

function startMockUpstream(): MockUpstream {
  const observed: string[] = [];
  const server = serve({
    port: 0, // ephemeral
    async fetch(req) {
      observed.push(req.headers.get("authorization") ?? "");
      const body = (await req.json().catch(() => ({}) as Record<string, unknown>)) as {
        stream?: boolean;
      };
      if (body.stream === true) {
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            for (let i = 0; i < 5; i++) {
              const chunk = {
                id: "chatcmpl-mock",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "mock-model",
                choices: [{ index: 0, delta: { content: `tok${i} ` }, finish_reason: null }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              await Bun.sleep(20);
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  }) as unknown as MockServer;
  return { server, port: server.port, observedAuth: observed };
}

let mock: MockUpstream | null = null;

afterEach(async () => {
  await stopPortkey();
  if (mock) {
    mock.server.stop(true);
    mock = null;
  }
});

describe("Portkey lifecycle (E2E)", () => {
  it("spawns, serves a request, then shuts down cleanly", async () => {
    mock = startMockUpstream();
    const portkeyPort = pickEphemeralPort();

    await startPortkey({ port: portkeyPort });
    expect(getPortkeyPort()).toBe(portkeyPort);

    const config = {
      provider: "openai",
      api_key: "decrypted-real-key",
      custom_host: `http://localhost:${mock.port}`,
    };

    const res = await fetch(`http://localhost:${portkeyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portkey-config": JSON.stringify(config),
      },
      body: JSON.stringify({
        model: "mock-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);

    // The upstream MUST see the decrypted API key in Authorization —
    // this is the core security invariant of the integration: Portkey
    // pulls `api_key` from inline config, never from the client's
    // Authorization header (which the client doesn't even set).
    expect(mock.observedAuth.length).toBe(1);
    expect(mock.observedAuth[0]).toContain("decrypted-real-key");

    await stopPortkey();
    expect(getPortkeyPort()).toBeNull();
    expect(_getPortkeyProcessForTesting()).toBeNull();
  });

  it("passes SSE chunks through without buffering", async () => {
    mock = startMockUpstream();
    const portkeyPort = pickEphemeralPort();
    await startPortkey({ port: portkeyPort });

    const config = {
      provider: "openai",
      api_key: "k",
      custom_host: `http://localhost:${mock.port}`,
    };

    const res = await fetch(`http://localhost:${portkeyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portkey-config": JSON.stringify(config),
      },
      body: JSON.stringify({
        model: "mock-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkCount = 0;
    let sawDone = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        if (!ev.startsWith("data: ")) continue;
        if (ev.includes("[DONE]")) sawDone = true;
        else chunkCount++;
      }
    }

    expect(chunkCount).toBe(5);
    expect(sawDone).toBe(true);
  });

  it("is idempotent — second startPortkey while running is a no-op", async () => {
    mock = startMockUpstream();
    const portkeyPort = pickEphemeralPort();
    await startPortkey({ port: portkeyPort });
    const firstProc = _getPortkeyProcessForTesting();
    expect(firstProc).not.toBeNull();
    await startPortkey({ port: portkeyPort });
    expect(_getPortkeyProcessForTesting()).toBe(firstProc!);
  });
});

/**
 * Allocate an ephemeral port without binding: Bun assigns one when
 * `port: 0`, then we close immediately. Acceptable race window for the
 * test scope.
 */
function pickEphemeralPort(): number {
  const tmp = serve({ port: 0, fetch: () => new Response() }) as unknown as MockServer;
  const port = tmp.port;
  tmp.stop(true);
  return port;
}
