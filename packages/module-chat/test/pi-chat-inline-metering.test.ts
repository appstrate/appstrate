// SPDX-License-Identifier: Apache-2.0

/**
 * A subscription (inline-metered) chat turn records ONE usage row summed over
 * its model calls, with the tier band of every call that crossed a price tier
 * (`ChatUsageRecord.tiers`) — a summed prompt cannot say which call did.
 *
 * The session is injected (`PiChatInput.createSession`) and replays two model
 * calls; everything else, the MCP handshake included, runs for real.
 */

import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import type { ModelCost } from "@appstrate/core/module";
import { createPiOAuthModelBinding } from "../src/pi-chat/model-binding.ts";
import { runPiChat } from "../src/pi-chat/engine.ts";
import type { PiChatSession } from "../src/pi-chat/turn-control.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const ORGANIZATION = inertTurnSpaces();

const MCP_URL = "http://127.0.0.1:1/api/mcp/o/org_metering";

/** Haiku-5.5-like card: every rate ×5 above 100k prompt tokens. */
const COST: ModelCost = {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [
    { inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  ],
};

/** The platform MCP endpoint, answered in-process: a zero-tool surface. */
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
  const headers = msg.method === "initialize" ? { "mcp-session-id": "sess_metering" } : undefined;
  return Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers });
}) as typeof fetch;

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
const piUsage = (usage: Usage) => ({
  ...usage,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * A session whose prompt replays one assistant message per `usage` entry, then optionally a
 * summary billed `summarized`, then optionally throws.
 */
function replaySession(
  usages: Usage[],
  { summarized, throws }: { summarized?: Usage; throws?: boolean } = {},
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
      usages.forEach((usage, i) => {
        const message = {
          role: "assistant",
          stopReason: i < usages.length - 1 ? "toolUse" : "stop",
          usage: piUsage(usage),
        };
        listener({ type: "message_start", message });
        listener({ type: "message_end", message });
      });
      if (summarized) {
        listener({
          type: "compaction_end",
          reason: "threshold",
          result: {
            summary: "Résumé",
            firstKeptEntryId: "entry_live",
            tokensBefore: 150_000,
            usage: piUsage(summarized),
          },
          aborted: false,
        });
      }
      if (throws) throw new Error("tool host crashed");
    },
    abort: async () => {},
  };
}

const BINDING = createPiOAuthModelBinding(
  {
    modelId: "claude-sonnet-4-5",
    apiShape: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    accessToken: "oauth-secret-in-memory",
    credentialId: "cred-test",
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 16_384,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  { pi_provider: "anthropic", pi_dialect: null },
);

/** The rows a turn driven by `session` records. */
async function recordedBy(
  session: PiChatSession,
): Promise<Omit<ChatUsageRecord, "credentialId">[]> {
  const recorded: Omit<ChatUsageRecord, "credentialId">[] = [];
  const res = runPiChat({
    slot: { release() {} },
    modelBinding: BINDING,
    presetId: "preset_metering",
    modelLabel: "Metering preset",
    orgId: "org_metering",
    userId: "user_metering",
    chatSessionId: null,
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "bonjour" }] },
    ] as UIMessage[],
    system: "You are a helpful assistant.",
    generation: {},
    platformMcp: { url: MCP_URL, headers: {}, organization: ORGANIZATION, fetch: mcpFetch },
    abortSignal: new AbortController().signal,
    onError: (error) => String(error),
    recordUsage: (record) => recorded.push(record),
    createSession: async () => ({ session }),
  });
  await res.text();
  return recorded;
}

const CALL = { input: 1_200, output: 300, cacheRead: 4_000, cacheWrite: 0 };

describe("inline-metered chat turn, on every exit", () => {
  it("records the settled calls of a turn that then threw, once", async () => {
    const recorded = await recordedBy(replaySession([CALL], { throws: true }));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 4_000,
    });
  }, 20_000);

  it("records the summary's tokens with the turn's calls", async () => {
    const recorded = await recordedBy(
      replaySession([CALL], {
        summarized: { input: 50_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ inputTokens: 51_200, outputTokens: 2_300 });
  }, 20_000);

  it("records nothing for a turn that spent nothing", async () => {
    expect(await recordedBy(replaySession([], { throws: true }))).toEqual([]);
  }, 20_000);
});

describe("inline-metered chat turn", () => {
  it("records the turn once, with the band of the call over the 100k tier", async () => {
    const binding = createPiOAuthModelBinding(
      {
        modelId: "claude-sonnet-4-5",
        apiShape: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        accessToken: "oauth-secret-in-memory",
        credentialId: "cred-test",
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
        reasoning: false,
        cost: COST,
      },
      { pi_provider: "anthropic", pi_dialect: null },
    );
    const recorded: Omit<ChatUsageRecord, "credentialId">[] = [];
    const session = replaySession([
      // 20k prompt: base rate.
      { input: 20_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
      // 30k + 80k cached = 110k prompt: over the tier.
      { input: 30_000, output: 2_000, cacheRead: 80_000, cacheWrite: 0 },
    ]);

    const res = runPiChat({
      slot: { release() {} },
      modelBinding: binding,
      presetId: "preset_metering",
      modelLabel: "Metering preset",
      orgId: "org_metering",
      userId: "user_metering",
      chatSessionId: null,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "bonjour" }] },
      ] as UIMessage[],
      system: "You are a helpful assistant.",
      generation: {},
      platformMcp: { url: MCP_URL, headers: {}, organization: ORGANIZATION, fetch: mcpFetch },
      abortSignal: new AbortController().signal,
      onError: (error) => String(error),
      recordUsage: (record) => recorded.push(record),
      createSession: async () => ({ session }),
    });
    await res.text();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      inputTokens: 50_000,
      outputTokens: 3_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 0,
      cost: COST,
      tiers: [
        {
          input_tokens_above: 100_000,
          input_tokens: 30_000,
          output_tokens: 2_000,
          cache_read_input_tokens: 80_000,
          cache_creation_input_tokens: 0,
        },
      ],
    });
  }, 20_000);
});
