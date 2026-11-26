// SPDX-License-Identifier: Apache-2.0

/**
 * Which calls the chat stamps a lookup: the tools the platform declares lookups (`isLookupTool`),
 * read off its MCP surface, and the chat's own `read_resource`. The session is injected
 * (`PiChatInput.createSession`) and replays one call of each tool.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { TOOL_LOOKUP_META_KEY } from "@appstrate/core/mcp-presentation";
import { createPiOAuthModelBinding } from "../src/pi-chat/model-binding.ts";
import { runPiChat } from "../src/pi-chat/engine.ts";
import type { PiChatSession } from "../src/pi-chat/turn-control.ts";
import { stubPlatformMcp } from "./pi-turn.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const schema = { type: "object" };
/** The surface: a read-only tool, one stamped a lookup, one that writes. */
const TOOLS = [
  { name: "describe", inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: "search", inputSchema: schema, _meta: { [TOOL_LOOKUP_META_KEY]: true } },
  { name: "invoke_operation", inputSchema: schema, annotations: { readOnlyHint: false } },
];

/** A session that calls each tool of {@link TOOLS} once, and `read_resource`. */
function callingSession(): PiChatSession {
  let listener: (event: unknown) => void = () => {};
  return {
    agent: {},
    setActiveToolsByName: () => {},
    subscribe: (cb) => {
      listener = cb;
      return () => {};
    },
    prompt: async () => {
      const message = {
        role: "assistant",
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      listener({ type: "message_start", message });
      [...TOOLS.map((tool) => tool.name), "read_resource"].forEach((name, contentIndex) => {
        const toolCall = { type: "toolCall", id: `call_${name}`, name, arguments: {} };
        const content = Object.assign([], { [contentIndex]: toolCall });
        listener({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "toolcall_start", contentIndex, partial: { content } },
        });
        listener({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall, partial: {} },
        });
      });
      listener({ type: "message_end", message: { ...message, stopReason: "stop" } });
    },
    abort: async () => {},
  };
}

/** The `tool-input-start` chunks of the turn's SSE body, by tool name. */
async function inputStarts(res: Response): Promise<Record<string, unknown>> {
  const starts: Record<string, unknown> = {};
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice("data: ".length)) as {
      type?: string;
      toolName?: string;
      providerMetadata?: unknown;
    };
    if (chunk.type === "tool-input-start" && chunk.toolName) {
      starts[chunk.toolName] = chunk.providerMetadata;
    }
  }
  return starts;
}

describe("a chat turn", () => {
  it("stamps a lookup the calls of the tools the platform declares lookups, from their first chunk", async () => {
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      { pi_provider: "anthropic", pi_dialect: null },
    );
    const res = runPiChat({
      slot: { release() {} },
      modelBinding: binding,
      presetId: "preset_lookup",
      modelLabel: "Lookup preset",
      orgId: "org_lookup",
      userId: "user_lookup",
      chatSessionId: null,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "bonjour" }] },
      ] as UIMessage[],
      system: "You are a helpful assistant.",
      generation: {},
      platformMcp: { ...stubPlatformMcp(TOOLS), headers: {}, organization: inertTurnSpaces() },
      abortSignal: new AbortController().signal,
      onError: (error) => String(error),
      recordUsage: () => {},
      createSession: async () => ({ session: callingSession() }),
    });
    expect(await inputStarts(res)).toEqual({
      describe: { appstrate: { lookup: true } },
      search: { appstrate: { lookup: true } },
      invoke_operation: undefined,
      read_resource: { appstrate: { lookup: true } },
    });
  }, 20_000);
});
