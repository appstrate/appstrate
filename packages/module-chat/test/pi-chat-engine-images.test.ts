// SPDX-License-Identifier: Apache-2.0

/**
 * What the engine hands Pi for an attached image, asserted by DRIVING a turn (the session is the
 * injected seam `PiChatInput.createSession`, the rest runs for real: MCP handshake, Pi SDK, the
 * projection and the real `resizeImage`).
 *
 * A model that accepts `image` gets the downscaled pixels on `prompt(…, { images })`; a text-only
 * model gets none and its prompt says it cannot view them; the image is never read for it.
 */

import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import { createPiProxyModelBinding } from "../src/pi-chat/model-binding.ts";
import { runPiChat, type PiChatInput } from "../src/pi-chat/engine.ts";
import type { PiChatSession } from "../src/pi-chat/turn-control.ts";
import type { OrgModel } from "../src/llm.ts";
import type { TurnSpaces } from "../src/pi-chat/mcp-tools.ts";

const ORIGIN = "http://127.0.0.1:1";
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const ORGANIZATION: TurnSpaces = {
  spaces: [{ id: "spc_1", name: "One", role: "admin" }],
  touch: async () => {},
  spaceOfUri: async () => undefined,
};

/** A platform MCP endpoint with no tool: only the handshake is answered. */
const mcpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 202 });
  const msg = (await req.json()) as { id?: unknown; method?: string };
  if (!("id" in msg) || msg.id === undefined) return new Response(null, { status: 202 });
  const reply = (result: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });
  if (msg.method === "initialize") {
    return reply(
      {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
      },
      { "mcp-session-id": "sess_images" },
    );
  }
  if (msg.method === "tools/list") return reply({ tools: [] });
  return reply({});
}) as typeof fetch;

const orgModel = (input: Array<"text" | "image">): OrgModel => ({
  id: "preset_images",
  modelId: "upstream-model-never-called",
  apiShape: "openai-completions",
  providerId: "openai",
  pi_provider: "openai",
  pi_dialect: null,
  label: "Images test model",
  enabled: true,
  input,
  contextWindow: 128_000,
  maxTokens: 4_096,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
});

const MESSAGES: UIMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [
      { type: "text", text: "Que montre ce graphique ?" },
      { type: "file", url: "appfile://file_chart", mediaType: "image/png", filename: "chart.png" },
    ],
  },
];

async function drive(input: Array<"text" | "image">) {
  const prompts: Array<{
    text: string;
    options: { images?: Array<{ type: string; mimeType: string; data: string }> };
  }> = [];
  const reads: string[] = [];
  const session = {
    agent: {},
    setActiveToolsByName: () => {},
    prompt: async (text: string, options: never) => {
      prompts.push({ text, options });
    },
    subscribe: () => () => {},
    abort: async () => {},
  } as unknown as PiChatSession;

  const res = runPiChat({
    slot: { release() {} },
    modelBinding: createPiProxyModelBinding({
      model: orgModel(input),
      origin: ORIGIN,
      mintBearer: () => "loopback-images",
    })!,
    presetId: "preset_images",
    modelLabel: "Images preset",
    orgId: "org_images",
    userId: "user_images",
    chatSessionId: null,
    messages: MESSAGES,
    readImage: async (uri) => {
      reads.push(uri);
      return { mime: "image/png", data: PIXEL_PNG.toString("base64"), size: PIXEL_PNG.length };
    },
    system: "You are a helpful assistant.",
    generation: {},
    platformMcp: {
      url: `${ORIGIN}/api/mcp/o/org_images`,
      headers: {},
      organization: ORGANIZATION,
      fetch: mcpFetch,
    },
    abortSignal: new AbortController().signal,
    onError: (error) => String(error),
    recordUsage: () => {},
    createSession: (async () => ({ session })) as NonNullable<PiChatInput["createSession"]>,
  });
  await res.text();
  return { prompts, reads };
}

describe("engine: attached images", () => {
  it("hands a vision model the downscaled pixels on the prompt, next to the pointer line", async () => {
    const { prompts, reads } = await drive(["text", "image"]);
    expect(reads).toEqual(["appfile://file_chart"]);
    expect(prompts).toHaveLength(1);
    const { text, options } = prompts[0]!;
    expect(options.images).toHaveLength(1);
    expect(options.images![0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(options.images![0]!.data.length).toBeGreaterThan(0);
    // The URI stays on the text line, so the file can still be chained into a run.
    expect(text).toContain("appfile://file_chart");
    expect(text).not.toContain("cannot view images");
  });

  it("hands a text-only model no image, never reads the file, and tells the model so", async () => {
    const { prompts, reads } = await drive(["text"]);
    expect(reads).toEqual([]);
    const { text, options } = prompts[0]!;
    expect(options.images).toBeUndefined();
    expect(text).toContain("you cannot view images with this model");
  });
});
