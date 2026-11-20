// SPDX-License-Identifier: Apache-2.0

/**
 * A chat turn closes with the context its NEXT request carries
 * (`appstrate.turn.context`): the last settled call's tokens over the window
 * the session ran against, never the turn's summed usage.
 *
 * The session is injected (`PiChatInput.createSession`) and replays two model
 * calls; the MCP handshake runs for real against an in-process zero-tool server.
 */

import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import { createPiOAuthModelBinding } from "../src/pi-chat/model-binding.ts";
import { runPiChat } from "../src/pi-chat/engine.ts";
import type { PiChatSession } from "../src/pi-chat/turn-control.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const MCP_URL = "http://127.0.0.1:1/api/mcp/o/org_context";

const mcpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 202 });
  const msg = (await req.json()) as { id?: unknown; method?: string };
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const result =
    msg.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
        }
      : msg.method === "tools/list"
        ? { tools: [] }
        : {};
  const headers = msg.method === "initialize" ? { "mcp-session-id": "sess_context" } : undefined;
  return Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers });
}) as typeof fetch;

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

interface Replay {
  /** Where Pi summarized: before the first call, or after the last. */
  compacts?: "before" | "after";
  /** The entry Pi kept from, picked off the reconstructed session; default: a live one. */
  keep?: (session: { getBranch(): Array<{ id: string }> }) => string;
  /** Every call fails, so none settles. */
  fails?: boolean;
}

function replaySession(
  usages: Usage[],
  sessionManager: { getBranch(): Array<{ id: string }> },
  { compacts, keep, fails }: Replay,
): PiChatSession {
  let listener: (event: unknown) => void = () => {};
  return {
    agent: {},
    setActiveToolsByName: () => {},
    subscribe: (cb) => {
      listener = cb;
      return () => {};
    },
    prompt: async () => {
      const compaction = {
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "Résumé du fil",
          firstKeptEntryId: keep?.(sessionManager) ?? "entry_live",
          tokensBefore: 150_000,
          estimatedTokensAfter: 40_000,
        },
        aborted: false,
      };
      if (compacts === "before") listener(compaction);
      usages.forEach((usage, i) => {
        const message = {
          role: "assistant",
          stopReason: fails ? "error" : i < usages.length - 1 ? "toolUse" : "stop",
          ...(fails ? { errorMessage: "upstream 503" } : {}),
          usage: {
            ...usage,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        listener({ type: "message_start", message });
        listener({ type: "message_end", message });
      });
      if (compacts === "after") listener(compaction);
    },
    abort: async () => {},
  };
}

/** The `finish` chunk's turn metadata, read off the SSE body. */
async function closingTurn(res: Response): Promise<Record<string, unknown> | undefined> {
  const body = await res.text();
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as {
      type?: string;
      messageMetadata?: { appstrate?: { turn?: Record<string, unknown> } };
    };
    if (chunk.type === "finish") return chunk.messageMetadata?.appstrate?.turn;
  }
  return undefined;
}

const HISTORY = [
  { id: "u0", role: "user", parts: [{ type: "text", text: "première question" }] },
  { id: "a0", role: "assistant", parts: [{ type: "text", text: "première réponse" }] },
] as UIMessage[];

function turn(
  usages: Usage[],
  contextWindow: number | null,
  replay: Replay = {},
  history: UIMessage[] = [],
) {
  const binding = createPiOAuthModelBinding(
    {
      modelId: "claude-sonnet-4-5",
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      accessToken: "oauth-secret-in-memory",
      credentialId: "cred-test",
      input: ["text"],
      contextWindow,
      maxTokens: 16_384,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { pi_provider: "anthropic", pi_dialect: null },
  );
  return runPiChat({
    slot: { release() {} },
    modelBinding: binding,
    presetId: "preset_context",
    modelLabel: "Context preset",
    orgId: "org_context",
    userId: "user_context",
    chatSessionId: null,
    messages: [
      ...history,
      { id: "u1", role: "user", parts: [{ type: "text", text: "bonjour" }] },
    ] as UIMessage[],
    system: "You are a helpful assistant.",
    generation: {},
    platformMcp: { url: MCP_URL, headers: {}, organization: inertTurnSpaces(), fetch: mcpFetch },
    abortSignal: new AbortController().signal,
    onError: (error) => String(error),
    recordUsage: () => {},
    createSession: async (options) => ({
      session: replaySession(
        usages,
        options!.sessionManager as unknown as { getBranch(): Array<{ id: string }> },
        replay,
      ),
    }),
  });
}

describe("chat turn context", () => {
  it("closes with the last call's context over the model's window", async () => {
    const meta = await closingTurn(
      turn(
        [
          { input: 2_000, output: 500, cacheRead: 30_000, cacheWrite: 0 },
          { input: 1_000, output: 700, cacheRead: 32_500, cacheWrite: 0 },
        ],
        200_000,
      ),
    );
    expect(meta?.context).toEqual({ tokens: 34_200, window: 200_000, compactAt: 183_616 });
  }, 20_000);

  it("measures against the fallback window the session really ran on", async () => {
    const meta = await closingTurn(
      turn([{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }], null),
    );
    expect(meta?.context).toMatchObject({ tokens: 15, window: 128_000 });
  }, 20_000);

  it("keeps a summary made before the first call or after the last", async () => {
    const call = [{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }];
    for (const compacts of ["before", "after"] as const) {
      expect((await closingTurn(turn(call, 200_000, { compacts })))?.summary).toEqual({
        text: "Résumé du fil",
        keptFrom: { messageId: "u1", offset: 0 },
        tokensBefore: 150_000,
      });
    }
    expect(await closingTurn(turn(call, 200_000))).not.toHaveProperty("summary");
  }, 20_000);

  it("stores Pi's post-summary estimate when the summary followed the last call", async () => {
    // Pi summarizes after the turn's last reply: that reply measured the history before it.
    const full = [{ input: 190_000, output: 500, cacheRead: 0, cacheWrite: 0 }];
    const after = await closingTurn(turn(full, 200_000, { compacts: "after" }));
    expect(after?.context).toEqual({ tokens: 40_000, window: 200_000, compactAt: 183_616 });
    const before = await closingTurn(turn(full, 200_000, { compacts: "before" }));
    expect(before?.context).toMatchObject({ tokens: 190_500 });
  }, 20_000);

  it("names a kept history entry by the branch message it was projected from", async () => {
    const meta = await closingTurn(
      turn(
        [{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }],
        200_000,
        { compacts: "before", keep: (session) => session.getBranch()[1]!.id },
        HISTORY,
      ),
    );
    expect(meta?.summary).toMatchObject({ keptFrom: { messageId: "a0", offset: 0 } });
  }, 20_000);

  it("keeps the summary of a turn that failed before any call settled", async () => {
    const meta = await closingTurn(
      turn([{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }], 200_000, {
        compacts: "before",
        fails: true,
      }),
    );
    // No call measured anything: the context is Pi's estimate after its summary.
    expect(meta).toMatchObject({
      finishReason: "error",
      summary: { text: "Résumé du fil" },
      context: { tokens: 40_000 },
    });
  }, 20_000);
});
