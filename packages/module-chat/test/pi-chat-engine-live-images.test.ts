// SPDX-License-Identifier: Apache-2.0

/**
 * Images through a REAL Pi session, end to end, with no network and no provider key.
 *
 * A local stub plays both servers the engine talks to (the platform MCP endpoint, which advertises a
 * `read_file` tool that answers with an image block, and an OpenAI-compatible provider that records
 * every request body), so what is asserted is what a provider would actually receive:
 *   - an attached image reaches a vision model as an `image_url` part and a text-only model as
 *     nothing but its pointer line;
 *   - an image a tool returns reaches a vision model (downscaled) and a text-only model as a pointer;
 *   - no pixel ever appears in the UI stream, which is what gets persisted.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import type { UIMessage } from "ai";
import { createPiProxyModelBinding } from "../src/pi-chat/model-binding.ts";
import { acquirePiChatSlot } from "../src/pi-chat/concurrency.ts";
import { runPiChat } from "../src/pi-chat/engine.ts";
import type { TurnSpaces } from "../src/pi-chat/mcp-tools.ts";
import type { OrgModel } from "../src/llm.ts";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const ORGANIZATION: TurnSpaces = {
  spaces: [{ id: "spc_img", name: "Img", role: "admin" }],
  touch: async () => {},
  spaceOfUri: async () => undefined,
};

const READ_FILE_TOOL = {
  name: "read_file",
  description: "Read a file by its appfile:// URI.",
  inputSchema: {
    type: "object",
    properties: { uri: { type: "string" } },
    required: ["uri"],
    additionalProperties: false,
  },
};

/** Provider request bodies, in order, and whether the stub should ask for `read_file` first. */
let bodies: string[] = [];
let askForReadFile = false;

async function mcpResponse(req: Request): Promise<Response> {
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 202 });
  const msg = (await req.json()) as { id?: unknown; method?: string };
  if (!("id" in msg) || msg.id === undefined) return new Response(null, { status: 202 });
  const json = (result: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });
  if (msg.method === "initialize") {
    return json(
      {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
      },
      { "mcp-session-id": "sess_images" },
    );
  }
  if (msg.method === "tools/list") return json({ tools: [READ_FILE_TOOL] });
  if (msg.method === "tools/call") {
    return json({
      content: [
        { type: "text", text: "[image image/png — appfile://file_chart]" },
        { type: "image", data: PIXEL_PNG.toString("base64"), mimeType: "image/png" },
      ],
    });
  }
  return json({});
}

const sse = (frames: string) =>
  new Response(frames + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const frame = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageFrame = (finish: string) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n`;

/** The first request asks for `read_file` when scripted to; every other request answers with text. */
function providerResponse(): Response {
  if (askForReadFile && bodies.length === 1) {
    return sse(
      frame({ role: "assistant" }) +
        frame({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"uri":"appfile://file_chart"}' },
            },
          ],
        }) +
        usageFrame("tool_calls"),
    );
  }
  return sse(
    frame({ role: "assistant" }) + frame({ content: "Je vois un pixel." }) + usageFrame("stop"),
  );
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/chat/completions")) {
      bodies.push(await req.text());
      return providerResponse();
    }
    if (path.startsWith("/api/mcp/")) return mcpResponse(req);
    return new Response("unexpected: " + path, { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));
beforeEach(() => {
  bodies = [];
  askForReadFile = false;
});

const orgModel = (input: Array<"text" | "image">): OrgModel => ({
  id: "preset_img",
  modelId: "upstream-model",
  apiShape: "openai-completions",
  providerId: "openai",
  pi_provider: "openai",
  pi_dialect: null,
  label: "Images live model",
  enabled: true,
  input,
  contextWindow: 128_000,
  maxTokens: 4_096,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
});

const ATTACHMENT_TURN: UIMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [
      { type: "text", text: "Que montre ce graphique ?" },
      { type: "file", url: "appfile://file_chart", mediaType: "image/png", filename: "chart.png" },
    ],
  },
];
const TEXT_TURN: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Lis appfile://file_chart" }] },
];

/** Drive one real turn; returns the UI stream's raw text (what the client, and the transcript, get). */
async function runTurn(input: Array<"text" | "image">, messages: UIMessage[]) {
  const slot = acquirePiChatSlot();
  expect(slot).not.toBeNull();
  try {
    const res = runPiChat({
      slot: slot!,
      modelBinding: createPiProxyModelBinding({
        model: orgModel(input),
        origin: ORIGIN,
        mintBearer: () => "loopback-img",
      })!,
      presetId: "preset_img",
      modelLabel: "Images live",
      orgId: "org_img",
      userId: "user_img",
      chatSessionId: null,
      messages,
      readImage: async () => ({
        mime: "image/png",
        data: PIXEL_PNG.toString("base64"),
        size: PIXEL_PNG.length,
      }),
      system: "You are a helpful assistant.",
      generation: {},
      platformMcp: {
        url: `${ORIGIN}/api/mcp/o/org_img?renders_cards=true`,
        headers: {},
        organization: ORGANIZATION,
      },
      abortSignal: new AbortController().signal,
      onError: (error) => String(error),
      recordUsage: () => {},
    });
    return await res.text();
  } finally {
    slot!.release();
  }
}

const imageParts = (body: string) =>
  (JSON.parse(body) as { messages: Array<{ content: unknown }> }).messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Array<{ type: string; image_url?: { url: string } }>).filter(
          (part) => part.type === "image_url",
        )
      : [],
  );

describe("an attached image, through a real Pi session", () => {
  it("reaches a vision model as an image part next to the pointer line", async () => {
    const stream = await runTurn(["text", "image"], ATTACHMENT_TURN);
    expect(bodies).toHaveLength(1);
    const parts = imageParts(bodies[0]!);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.image_url!.url).toStartWith("data:image/png;base64,");
    expect(bodies[0]).toContain("appfile://file_chart");
    expect(stream).toContain("Je vois un pixel.");
  }, 30_000);

  it("reaches a text-only model as its pointer line alone, with a notice", async () => {
    await runTurn(["text"], ATTACHMENT_TURN);
    expect(imageParts(bodies[0]!)).toHaveLength(0);
    expect(bodies[0]).toContain("appfile://file_chart");
    expect(bodies[0]).toContain("you cannot view images with this model");
  }, 30_000);
});

describe("an image a tool returns, through a real Pi session", () => {
  it("reaches a vision model on the next request, and never the UI stream", async () => {
    askForReadFile = true;
    const stream = await runTurn(["text", "image"], TEXT_TURN);
    expect(bodies).toHaveLength(2);
    // The first request carries no image; the second carries the tool's, downscaled by Pi.
    expect(imageParts(bodies[0]!)).toHaveLength(0);
    const parts = imageParts(bodies[1]!);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.image_url!.url).toStartWith("data:image/");
    // What the client receives and the transcript persists holds a pointer, never the pixels.
    expect(stream).not.toContain("data:image");
    expect(stream).not.toContain('"type":"image"');
    expect(stream).not.toContain(PIXEL_PNG.toString("base64"));
    expect(stream).toContain("[image image/png");
  }, 30_000);

  it("reaches a text-only model as a pointer", async () => {
    askForReadFile = true;
    await runTurn(["text"], TEXT_TURN);
    expect(bodies).toHaveLength(2);
    expect(imageParts(bodies[1]!)).toHaveLength(0);
    expect(bodies[1]).toContain("[image image/png");
  }, 30_000);
});
