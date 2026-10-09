// SPDX-License-Identifier: Apache-2.0

/**
 * The transport choice of `/api/mcp/o/:org` (#1844): a `tools/call` carrying
 * `params._meta.progressToken` is answered over SSE — headers and a first
 * comment at once, the result as an event when the tool finishes — and every
 * other call keeps the plain JSON response.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  MCP_ACCEPT,
  mcpHeaders,
  mcpPath,
  sseMessages,
  type JsonRpcEnvelope,
} from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";
import {
  createFakeOrchestrator,
  inlineAgentManifest,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

const app = getTestApp();
await registerTestPlatformApp();

const SSE_OPEN = ": stream open\n\n";

let ctx: TestContext;
let headers: Record<string, string>;

/** The init of a `tools/call` POST to the caller's endpoint, with `_meta` when given. */
function toolCall(
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): RequestInit {
  return {
    method: "POST",
    headers: { ...mcpHeaders(headers), "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
    }),
  };
}

/** POST a `search_operations` call, with `_meta` when given. */
async function searchOperations(meta?: Record<string, unknown>): Promise<Response> {
  return app.request(mcpPath(headers), toolCall("search_operations", { query: "agent" }, meta));
}

/** The JSON payload a tool returns in its first text block. */
function toolData(envelope: JsonRpcEnvelope): Record<string, unknown> {
  const [first] = envelope.result?.content as Array<{ text: string }>;
  return JSON.parse(first!.text) as Record<string, unknown>;
}

/** The one JSON-RPC result (or error) an SSE body carries. */
function sseResult(text: string): JsonRpcEnvelope {
  const results = sseMessages(text).filter((m) => m.result !== undefined || m.error !== undefined);
  expect(results).toHaveLength(1);
  return results[0]!;
}

// Runs exit only when the test opens the gate, so a tool call can be held
// mid-wait; the rest of the fake orchestrator is inert.
let openGate: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
function holdRuns(): void {
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
}

beforeAll(() => {
  _setOrchestratorForTesting({
    ...createFakeOrchestrator(),
    async waitForExit() {
      await gate;
      return 0;
    },
  });
});

afterAll(() => {
  _setOrchestratorForTesting(null);
});

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  // Pinned: this suite is about the transport, not the space a call names.
  headers = authHeaders(ctx);
});

// Launched runs are fire-and-forget: let them land before the next truncate.
afterEach(async () => {
  openGate();
  await waitForRunPipelineSettled();
});

describe("mcp transport: SSE only when progress is asked for", () => {
  it("streams a tools/call carrying a progressToken and ends the stream with its result", async () => {
    const res = await searchOperations({ progressToken: "progress-1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");

    // `text()` resolving at all proves the stream was closed after the result.
    const text = await res.text();
    expect(text).toStartWith(SSE_OPEN);
    const result = sseResult(text);
    expect(result.error).toBeUndefined();
    expect(toolData(result).total as number).toBeGreaterThan(0);
  });

  it("keeps the plain JSON response for the same call without a progressToken", async () => {
    const res = await searchOperations();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    const envelope = (await res.json()) as JsonRpcEnvelope;
    expect(toolData(envelope).total as number).toBeGreaterThan(0);
  });

  it("answers an unparseable body as JSON, through the SDK's own parse error", async () => {
    const res = await app.request(mcpPath(headers), {
      method: "POST",
      headers: { ...mcpHeaders(headers), "content-type": "application/json", Accept: MCP_ACCEPT },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"progressToken":"x"',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    const envelope = (await res.json()) as JsonRpcEnvelope;
    expect(envelope.error?.code).toBe(-32700);
  });
});

describe("mcp transport: progress on the wire", () => {
  // Waits one real heartbeat (15 s) on purpose: fake timers would stall the run pipeline.
  it("streams the heartbeat's notifications/progress, with the caller's token, before the result", async () => {
    await seedDefaultOrgModel(ctx);
    holdRuns();
    const res = await app.request(
      mcpPath(headers),
      toolCall(
        "run_and_wait",
        { kind: "inline", manifest: inlineAgentManifest(), prompt: "do the thing" },
        { progressToken: "beat-1" },
      ),
    );
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // Complete events only: a chunk may end mid-line.
    const hasBeat = () =>
      sseMessages(text.slice(0, text.lastIndexOf("\n\n") + 1)).some(
        (m) => m.method === "notifications/progress",
      );

    // The run is held, so the first beat necessarily precedes the result.
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      text += decoder.decode(chunk.value, { stream: true });
      if (hasBeat()) break;
    }
    expect(hasBeat()).toBe(true);
    openGate();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      text += decoder.decode(chunk.value, { stream: true });
    }

    const messages = sseMessages(text);
    const beatAt = messages.findIndex((m) => m.method === "notifications/progress");
    const resultAt = messages.findIndex((m) => m.result !== undefined || m.error !== undefined);
    expect(beatAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeGreaterThan(beatAt);
    expect(
      (messages[beatAt] as { params?: { progressToken?: unknown } }).params?.progressToken,
    ).toBe("beat-1");
    expect(toolData(messages[resultAt]!).done).toBe(true);
  }, 30_000);
});

describe("mcp transport: a held run_and_wait over a real socket", () => {
  it("sends the headers and a first byte while the run is still going, then the result", async () => {
    await seedDefaultOrgModel(ctx);
    holdRuns();
    // A real socket: `app.request` hands back the Response object whatever
    // Bun would put on the wire, and Bun sends headers with the first chunk.
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const pending = fetch(
        `http://127.0.0.1:${server.port}${mcpPath(headers)}`,
        toolCall(
          "run_and_wait",
          { kind: "inline", manifest: inlineAgentManifest(), prompt: "do the thing" },
          { progressToken: "run-1" },
        ),
      );
      // Well under the SDK's 15 s keep-alive, the only other early write.
      const res = await Promise.race([
        pending,
        Bun.sleep(5_000).then(() => {
          throw new Error("no response headers while the run is held");
        }),
      ]);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/event-stream");
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toStartWith(SSE_OPEN);

      // Only now may the run end: the tool was still waiting on it, and the
      // server it runs in must have outlived the handler's return.
      openGate();
      let text = first;
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        text += new TextDecoder().decode(chunk.value);
      }
      const data = toolData(sseResult(text));
      expect(data.done).toBe(true);
      expect(data.id as string).toStartWith("run_");
    } finally {
      openGate();
      await server.stop(true);
    }
  }, 30_000);
});
