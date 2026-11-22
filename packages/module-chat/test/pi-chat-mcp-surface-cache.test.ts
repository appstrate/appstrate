// SPDX-License-Identifier: Apache-2.0

/**
 * The cached platform MCP surface: a turn whose caller surface was seen before
 * registers its tools and gets its server instructions without a single MCP
 * hop, and opens the client only when the model calls a tool — once per turn.
 *
 * The stub origin is `http://127.0.0.1:1`, where nothing listens: every hop
 * the tool layer makes is visible in the stub's log or throws ECONNREFUSED, so
 * "zero hops" cannot pass by going around the seam.
 */

import type { FileDelivery } from "../src/file-input.ts";
import { createTurnPdfInput } from "../src/pi-chat/native-pdf.ts";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";
import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import {
  RESOURCE_BLOB_MAX_BYTES,
  RESOURCE_OVERSIZED_NOTE,
  RESOURCE_TEXT_MAX_BYTES,
} from "@appstrate/mcp-transport";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import {
  MCP_SURFACE_CACHE_MAX_ENTRIES,
  MCP_SURFACE_CACHE_TTL_MS,
  McpSurfaceCache,
  platformMcpSurfaceKey,
} from "../src/pi-chat/mcp-surface-cache.ts";
import { reachableSpace } from "./reachable-space.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const ORIGIN = "http://127.0.0.1:1";
const MCP_URL = `${ORIGIN}/api/mcp/o/org_1?renders_cards=true`;

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function register(factories: Array<(pi: ExtensionAPI) => void>): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  } as unknown as ExtensionAPI;
  for (const factory of factories) factory(pi);
  return tools;
}

/**
 * A platform MCP stub whose answer depends on the caller, like the real one:
 * the `x-surface` header names the tool it advertises. `failInitialize` makes
 * every `initialize` a 500 from then on; `initGate`, while set, holds every
 * `initialize` until it resolves.
 */
function mcpStub(imageBlocks?: Array<Record<string, unknown>>, isError = false) {
  const methods: string[] = [];
  const state: { failInitialize: boolean; initGate: Promise<void> | null } = {
    failInitialize: false,
    initGate: null,
  };
  const json = (body: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method !== "POST") {
      methods.push(req.method);
      return new Response(null, { status: req.method === "DELETE" ? 202 : 405 });
    }
    const msg = (await req.json()) as { id?: unknown; method?: string; params?: unknown };
    methods.push(msg.method ?? "?");
    if (!("id" in msg) || msg.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown, extra?: Record<string, string>) =>
      json({ jsonrpc: "2.0", id: msg.id, result }, extra);
    const surface = req.headers.get("x-surface") ?? "none";
    if (msg.method === "initialize") {
      if (state.initGate) await state.initGate;
      if (state.failInitialize) return new Response("boom", { status: 500 });
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
        instructions: `Instructions for ${surface}.\n\n## Operation index\n## Agents\nlistAgents`,
      });
    }
    if (msg.method === "tools/list") {
      if (surface === "file-reader")
        return reply({
          tools: [
            {
              name: "call_integration_tool",
              inputSchema: { type: "object" },
            },
          ],
        });
      return reply({
        tools: [
          {
            name: `search_${surface}`,
            description: `Search as ${surface}.`,
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      });
    }
    if (msg.method === "resources/read") {
      const { uri } = msg.params as { uri: string };
      if (uri.endsWith("/sample.png")) {
        return reply({ contents: [{ uri, mimeType: "image/png", blob: "iVBORw0KGgo=" }] });
      }
      if (uri === "appfile://private-file") {
        return reply({
          contents: [{ uri, mimeType: "text/plain", text: "the customer contract" }],
        });
      }
      if (uri.endsWith("/data.bin")) {
        return reply({ contents: [{ uri, mimeType: "application/octet-stream", blob: "AP8=" }] });
      }
      // At and one byte over the inline bounds the platform's file reads apply.
      const sized = /\/(text|blob)-(\d+)$/.exec(uri);
      if (sized) {
        const bytes = Number(sized[2]);
        return reply({
          contents: [
            sized[1] === "text"
              ? { uri, mimeType: "text/plain", text: "é".repeat(bytes / 2) }
              : {
                  uri,
                  mimeType: "application/octet-stream",
                  blob: Buffer.alloc(bytes).toString("base64"),
                },
          ],
        });
      }
      if (uri.endsWith("/SKILL.md")) {
        return reply({
          contents: [{ uri, mimeType: "text/markdown", text: "---\nname: tone\n---\n" }],
        });
      }
      return json({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32002, message: "Resource not found" },
      });
    }
    if (msg.method === "skills/list") {
      const meta = (msg.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
      const draft = meta?.["dev.appstrate/definition"] === "draft";
      const uri = `skill://spc_1/acme/tone${draft ? "@draft" : ""}/tone/SKILL.md`;
      return reply({
        skills: [
          {
            uri,
            frontmatter: {
              name: "tone",
              description: "Tone.",
              ...(draft ? {} : { metadata: { version: "1.2.0" } }),
            },
            resources: [{ uri, digest: "sha256:00", size: 1 }],
          },
        ],
      });
    }
    if (msg.method === "tools/call") {
      if (surface === "file-reader") {
        const args = (msg.params as { arguments: { tool: string } }).arguments;
        const remote = args.tool === "typed";
        if (imageBlocks) {
          return reply({
            content: imageBlocks,
            isError,
            ...(remote ? { _meta: { "dev.appstrate/relayed": true } } : {}),
          });
        }
        return reply({
          content: [
            { type: "text", text: '{"status":200}' },
            {
              type: "resource",
              resource: {
                uri: "urn:uuid:test",
                mimeType: "application/pdf",
                blob: btoa("%PDF-example"),
              },
            },
          ],
          ...(remote ? { _meta: { "dev.appstrate/relayed": true } } : {}),
        });
      }
      const params = msg.params as { name: string };
      return reply({ content: [{ type: "text", text: JSON.stringify({ called: params.name }) }] });
    }
    return reply({});
  }) as typeof fetch;

  return {
    fetch: impl,
    state,
    methods,
    count: (method: string) => methods.filter((m) => m === method).length,
    reset: () => methods.splice(0),
  };
}

/** A permission list no other test (or turn) in this process shares. */
function uniquePermissions(...extra: string[]): string[] {
  return ["mcp:read", "mcp:invoke", `test:${crypto.randomUUID()}`, ...extra];
}

/** The key of a turn reaching `spaces` (none by default: the key's other inputs are under test). */
const surfaceKey = (
  url: string,
  permissions: readonly string[],
  spaces: Parameters<typeof platformMcpSurfaceKey>[2] = [],
) => platformMcpSurfaceKey(url, permissions, spaces);

function buildTurn(
  stub: ReturnType<typeof mcpStub>,
  surface: string,
  surfaceKey: string | undefined,
  signal = new AbortController().signal,
  pdfInput?: ReturnType<typeof createTurnPdfInput>,
  fileDelivery: FileDelivery = { image: true, pdf: true },
) {
  return buildPlatformMcpTools({
    url: MCP_URL,
    headers: { authorization: "Bearer loopback", "x-surface": surface },
    // Every file named here is the conversation's own: it names no space.
    organization: inertTurnSpaces([{ id: "spc_1", name: "One", role: "owner", permissions: [] }]),
    writeChunk: () => {},
    signal,
    turnBudget: { deadlineAt: Date.now() + 10 * 60_000, stepCount: () => 0 },
    fetch: stub.fetch,
    ...(surfaceKey !== undefined ? { surfaceKey } : {}),
    fileDelivery,
    pdfInput,
  });
}

/** Resolves once `condition` holds, yielding a macrotask between checks. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

/** A cache hit whose lazy connect is held at `initialize` until `release()`. */
async function wedgedHit(signal?: AbortSignal) {
  const stub = mcpStub();
  const key = surfaceKey(MCP_URL, uniquePermissions());
  await (await buildTurn(stub, "alpha", key)).close();
  stub.reset();
  let release!: () => void;
  stub.state.initGate = new Promise((resolve) => (release = resolve));
  const turn = await buildTurn(stub, "alpha", key, signal);
  const [search] = register(turn.extensionFactories);
  const call = search!.execute("call_1", {});
  await until(() => stub.count("initialize") === 1);
  return { stub, key, turn, search: search!, call, release };
}

describe("platform MCP surface cache", () => {
  it("serves a repeated surface with zero MCP hops and byte-identical instructions", async () => {
    const stub = mcpStub();
    const key = surfaceKey(MCP_URL, uniquePermissions());

    const first = await buildTurn(stub, "alpha", key);
    await first.close();
    expect(first.surfaceCached).toBe(false);
    expect(stub.count("initialize")).toBe(1);
    expect(stub.count("tools/list")).toBe(1);

    stub.reset();
    const second = await buildTurn(stub, "alpha", key);
    try {
      expect(second.surfaceCached).toBe(true);
      // Nothing dispatched: no initialize, no initialized notification, no tools/list.
      expect(stub.methods).toEqual([]);
      // The prompt the model gets is the same bytes, so the provider cache still hits.
      expect(second.instructions).toBe(first.instructions!);
      const firstTools = register(first.extensionFactories);
      const secondTools = register(second.extensionFactories);
      expect(
        secondTools.map(({ name, description, parameters }) => [name, description, parameters]),
      ).toEqual(
        firstTools.map(({ name, description, parameters }) => [name, description, parameters]),
      );
    } finally {
      await second.close();
    }
    // A turn that never called a tool never opened a client, so closing it sends nothing.
    expect(stub.methods).toEqual([]);
  });

  it("opens the client once, on the first tool call, and reuses it for the rest of the turn", async () => {
    const stub = mcpStub();
    const key = surfaceKey(MCP_URL, uniquePermissions());
    await (await buildTurn(stub, "alpha", key)).close();

    stub.reset();
    const turn = await buildTurn(stub, "alpha", key);
    try {
      const [search] = register(turn.extensionFactories);
      expect(stub.methods).toEqual([]);

      const [a, b] = await Promise.all([
        search!.execute("call_1", { query: "x" }),
        search!.execute("call_2", { query: "y" }),
      ]);
      await search!.execute("call_3", { query: "z" });

      expect(JSON.parse(a.content[0]!.text)).toEqual({ called: "search_alpha" });
      expect(JSON.parse(b.content[0]!.text)).toEqual({ called: "search_alpha" });
      expect(stub.count("initialize")).toBe(1);
      // Answered locally (`answerStatelessHopsLocally`): never dispatched.
      expect(stub.count("notifications/initialized")).toBe(0);
      expect(stub.count("tools/list")).toBe(0);
      expect(stub.count("tools/call")).toBe(3);
    } finally {
      await turn.close();
    }
  });

  it("never shares an entry between permission sets", async () => {
    const stub = mcpStub();
    const shared = uniquePermissions();
    const keyA = surfaceKey(MCP_URL, shared);
    const keyB = surfaceKey(MCP_URL, [...shared, "agents:write"]);
    expect(keyB).not.toBe(keyA);

    await (await buildTurn(stub, "alpha", keyA)).close();
    stub.reset();
    const b = await buildTurn(stub, "beta", keyB);
    try {
      // B's first turn is a miss: it handshakes and gets B's own descriptors.
      expect(b.surfaceCached).toBe(false);
      expect(stub.count("initialize")).toBe(1);
      expect(stub.count("tools/list")).toBe(1);
      expect(register(b.extensionFactories).map((t) => t.name)).toEqual([
        "search_beta",
        "read_resource",
      ]);
      expect(b.instructions).toStartWith("Instructions for beta.");
    } finally {
      await b.close();
    }
  });

  it("keys on the permission SET and the surface flags, not on list order", () => {
    const perms = uniquePermissions("runs:read");
    const key = surfaceKey(MCP_URL, perms);
    expect(surfaceKey(MCP_URL, [...perms].reverse())).toBe(key);
    expect(surfaceKey(MCP_URL, [...perms, perms[0]!])).toBe(key);
    expect(surfaceKey(MCP_URL, perms.slice(1))).not.toBe(key);
    // `renders_cards=true` changes the server's instructions, so it is part of the surface.
    expect(surfaceKey(`${ORIGIN}/api/mcp/o/org_1`, perms)).not.toBe(key);
    expect(surfaceKey("http://other.test/api/mcp/o/org_1?renders_cards=true", perms)).not.toBe(key);
  });

  it("keys the organization's endpoint by its spaces", () => {
    const perms = uniquePermissions("runs:read");
    const org = `${ORIGIN}/api/mcp/o/org_1?renders_cards=true`;
    const alpha = reachableSpace({
      id: "spc_a",
      name: "Alpha",
      role: "operator",
      permissions: ["agents:run"],
      credentialProxyOpen: true,
    });
    const beta = reachableSpace({
      id: "spc_b",
      name: "Beta",
      role: "admin",
      permissions: ["agents:write"],
      credentialProxyOpen: true,
    });

    // The org id in the path reaches no descriptor.
    expect(surfaceKey(`${ORIGIN}/api/mcp/o/org_2?renders_cards=true`, perms)).toBe(
      surfaceKey(MCP_URL, perms),
    );
    // The spaces are written into every descriptor: another caller's reach is another surface.
    const both = surfaceKey(org, perms, [alpha, beta]);
    // In reach order: the descriptors list the spaces in that order.
    expect(surfaceKey(org, perms, [beta, alpha])).not.toBe(both);
    expect(surfaceKey(org, perms, [alpha])).not.toBe(both);
    expect(surfaceKey(org, perms, [alpha, { ...beta, name: "Other" }])).not.toBe(both);
    expect(surfaceKey(org, perms, [alpha, { ...beta, role: "viewer" }])).not.toBe(both);
    expect(surfaceKey(org, perms, [alpha, { ...beta, permissions: ["agents:run"] }])).not.toBe(
      both,
    );
    // A closed direct-access switch drops tools from that space's surface.
    expect(surfaceKey(org, perms, [alpha, { ...beta, credentialProxyOpen: false }])).not.toBe(both);
    // `describeSpace` marks the caller's personal space in every `space_id` description.
    expect(surfaceKey(org, perms, [alpha, { ...beta, personal: true }])).not.toBe(both);
  });

  it("surfaces a failed lazy connect as the tool call's error, retries it, and evicts the entry", async () => {
    const stub = mcpStub();
    const key = surfaceKey(MCP_URL, uniquePermissions());
    await (await buildTurn(stub, "alpha", key)).close();

    stub.state.failInitialize = true;
    stub.reset();
    const turn = await buildTurn(stub, "alpha", key);
    try {
      const [search] = register(turn.extensionFactories);
      await expect(search!.execute("call_1", {})).rejects.toThrow();
      // Not memoized: the next call tries again.
      await expect(search!.execute("call_2", {})).rejects.toThrow();
      expect(stub.count("initialize")).toBe(2);
    } finally {
      await turn.close();
    }

    // The next turn re-handshakes eagerly — here, failing the turn as it always did.
    stub.reset();
    await expect(buildTurn(stub, "alpha", key)).rejects.toThrow();
    expect(stub.count("initialize")).toBe(1);

    stub.state.failInitialize = false;
    const healed = await buildTurn(stub, "alpha", key);
    expect(healed.surfaceCached).toBe(false);
    await healed.close();
  });

  it("honours the turn's stop while a lazy connect is wedged, and keeps the entry", async () => {
    const stop = new AbortController();
    const { stub, key, turn, call, release } = await wedgedHit(stop.signal);
    try {
      stop.abort(new Error("stopped by user"));
      await expect(call).rejects.toThrow();
      await turn.close();
    } finally {
      release();
    }

    // A stop is not a server failure: the next turn is still a hit.
    stub.reset();
    const next = await buildTurn(stub, "alpha", key);
    expect(next.surfaceCached).toBe(true);
    await next.close();
  });

  it("rejects only the tool call whose own signal aborts while a lazy connect is in flight", async () => {
    const { stub, key, turn, search, call, release } = await wedgedHit();
    try {
      const own = new AbortController();
      const cancelled = search.execute("call_2", {}, own.signal);
      own.abort(new Error("tool call cancelled"));
      await expect(cancelled).rejects.toThrow("tool call cancelled");

      // The shared connect was not taken down: the other call lands once it opens.
      release();
      expect(JSON.parse((await call).content[0]!.text)).toEqual({ called: "search_alpha" });
      expect(stub.count("initialize")).toBe(1);
      expect(stub.count("tools/call")).toBe(1);
    } finally {
      release();
      await turn.close();
    }

    // Not a server failure: the entry stays.
    stub.reset();
    const next = await buildTurn(stub, "alpha", key);
    expect(next.surfaceCached).toBe(true);
    await next.close();
  });

  it("closes a lazy connect still in flight at teardown, and refuses calls after it", async () => {
    const { turn, search, call, release } = await wedgedHit();
    let closed = false;
    const closing = turn.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Teardown waits the connect out rather than leaving it open behind it.
    expect(closed).toBe(false);

    release();
    await closing;
    // The call that raced teardown may land or not; it must not hang.
    await call.catch(() => {});
    await expect(search.execute("call_2", {})).rejects.toThrow("already closed");
  });

  it("caches nothing and handshakes every turn without a surface key", async () => {
    const stub = mcpStub();
    for (let i = 0; i < 2; i++) {
      const turn = await buildTurn(stub, "alpha", undefined);
      expect(turn.surfaceCached).toBe(false);
      await turn.close();
    }
    expect(stub.count("initialize")).toBe(2);
    expect(stub.count("tools/list")).toBe(2);
  });
});

describe("McpSurfaceCache", () => {
  const surface = (name: string) => ({
    instructions: `for ${name}`,
    tools: [{ name, inputSchema: { type: "object" as const, properties: {} } }],
  });

  it("evicts the least recently used entry, refreshing its place on a read but never its TTL", () => {
    let now = 1_000;
    const cache = new McpSurfaceCache({ now: () => now });
    for (let i = 0; i < MCP_SURFACE_CACHE_MAX_ENTRIES; i++) cache.set(`k${i}`, surface(`t${i}`));
    // Read the oldest halfway to its expiry: it moves to the back of the LRU,
    // so the overflow evicts the second-oldest…
    now += MCP_SURFACE_CACHE_TTL_MS / 2;
    expect(cache.get("k0")).toBeDefined();
    cache.set("overflow", surface("overflow"));
    expect(cache.get("k1")).toBeUndefined();
    now += MCP_SURFACE_CACHE_TTL_MS / 2 - 1;
    expect(cache.get("k0")).toEqual(surface("t0"));
    // …but it still expires at the deadline its `set` gave it.
    now += 1;
    expect(cache.get("k0")).toBeUndefined();
    // The entry stored after it keeps its own, later deadline, and a re-store
    // (the next handshake) is fresh again.
    expect(cache.get("overflow")).toEqual(surface("overflow"));
    cache.set("k0", surface("t0"));
    expect(cache.get("k0")).toEqual(surface("t0"));
  });

  it("hands every reader its own copy", () => {
    const cache = new McpSurfaceCache();
    const original = surface("t");
    cache.set("k", original);
    original.tools[0]!.name = "mutated-after-set";
    const read = cache.get("k")!;
    read.tools[0]!.inputSchema.properties = { injected: {} };
    expect(cache.get("k")).toEqual(surface("t"));
  });
});

describe("inline images from remote integration tools", () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const image = { type: "image", mimeType: "image/png", data };
  const caption = { type: "text", text: "sample caption" };

  it("hands pixels to the live model and only a receipt to the stream and history", async () => {
    const stub = mcpStub([
      caption,
      image,
      { type: "resource_link", uri: "https://example.org/image", name: "link" },
    ]);
    const turn = await buildTurn(stub, "file-reader", undefined);
    try {
      const call = register(turn.extensionFactories).find(
        (t) => t.name === "call_integration_tool",
      )!;
      const result = await call.execute("photo", { tool: "typed" });
      expect(result.content.slice(0, 2)).toEqual([caption, image]);
      const chunks = new PiChatUiStreamMapper().map({
        type: "tool_execution_end",
        toolName: call.name,
        toolCallId: "photo",
        result,
        isError: false,
      });
      expect(JSON.stringify(chunks)).toContain("sample caption");
      expect(JSON.stringify(chunks)).toContain("image/png");
      expect(JSON.stringify(chunks)).not.toContain(data);
      expect(stub.count("tools/call")).toBe(1);
      expect(stub.count("resources/read")).toBe(0);
    } finally {
      await turn.close();
    }
  });

  it("keeps an error screenshot for the assistant while withholding user-only blocks", async () => {
    const audience = { audience: ["user"] };
    const hiddenData = Buffer.from("user-only-image").toString("base64");
    const diagnostic = { type: "text", text: "Preview failed" };
    const stub = mcpStub(
      [
        diagnostic,
        { ...image, annotations: { audience: ["user", "assistant"] } },
        { ...image, data: hiddenData, annotations: audience },
        { type: "text", text: "private caption", annotations: audience },
      ],
      true,
    );
    const turn = await buildTurn(stub, "file-reader", undefined);
    try {
      const call = register(turn.extensionFactories).find(
        (t) => t.name === "call_integration_tool",
      )!;
      const result = await call.execute("diagnostic", { tool: "typed" });
      expect(result).toMatchObject({ isError: true });
      expect(result.content.slice(0, 2)).toEqual([diagnostic, image]);
      expect(result.content.slice(2, 4)).toEqual(
        Array(2).fill({
          type: "text",
          text: "Tool content omitted from model input by its audience annotation.",
        }),
      );
      const chunks = new PiChatUiStreamMapper().map({
        type: "tool_execution_end",
        toolName: call.name,
        toolCallId: "diagnostic",
        result,
        isError: true,
      });
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: "tool-output-error",
          errorText: expect.stringContaining("Preview failed"),
        }),
      );
      expect(JSON.stringify(chunks)).toContain("read for this turn]");
      for (const secret of [data, hiddenData, "private caption"]) {
        expect(JSON.stringify(chunks)).not.toContain(secret);
      }
    } finally {
      await turn.close();
    }
  });

  for (const [name, block, seesImages, reason] of [
    ["text-only model", image, false, /model.*image/i],
    ["unsupported MIME", { ...image, mimeType: "image/svg+xml" }, true, /unsupported/i],
    [
      "oversized image",
      { ...image, data: Buffer.alloc(RESOURCE_BLOB_MAX_BYTES + 1).toString("base64") },
      true,
      /size limit/i,
    ],
    ["invalid image", { ...image, data: btoa("plain text") }, true, /invalid|match/i],
    ["mismatched MIME", { ...image, mimeType: "image/jpeg" }, true, /invalid|match/i],
  ] as const) {
    it(`explains a skipped image for ${name}`, async () => {
      const stub = mcpStub([block]);
      const turn = await buildTurn(stub, "file-reader", undefined, undefined, undefined, {
        image: seesImages,
        pdf: seesImages,
      });
      try {
        const call = register(turn.extensionFactories).find(
          (t) => t.name === "call_integration_tool",
        )!;
        const result = await call.execute("photo", { tool: "typed" });
        expect(result.content[0]?.type).toBe("text");
        expect(result.content[0]?.text).toMatch(reason);
        expect(JSON.stringify(result.content)).not.toContain(block.data);
      } finally {
        await turn.close();
      }
    });
  }
});

describe("temporary connector files", () => {
  it("hands the PDF to the current tool call, streams a receipt, and ignores relayed resource blocks", async () => {
    const pdf = createTurnPdfInput({ api: "openai-responses" }, { image: true, pdf: true });
    const added: string[] = [];
    const turn = await buildTurn(mcpStub(), "file-reader", undefined, undefined, {
      ...pdf,
      add(file, id) {
        expect(file.data).toBe(btoa("%PDF-example"));
        added.push(id!);
        return pdf.add(file, id);
      },
    });
    try {
      const call = register(turn.extensionFactories).find(
        (t) => t.name === "call_integration_tool",
      )!;
      const args = { arguments: { read_as_file: true } };
      const result = await call.execute("download-id", { ...args, tool: "crm__api_call" });
      expect(added).toEqual(["download-id"]);
      expect(JSON.stringify(result.content)).toMatch(/\[pdf:[0-9a-f-]{36}\]/);
      const chunks = new PiChatUiStreamMapper().map({
        type: "tool_execution_end",
        toolName: call.name,
        toolCallId: "download-id",
        result,
        isError: false,
      });
      expect(JSON.stringify(chunks)).not.toContain(btoa("%PDF-example"));
      expect(JSON.stringify(chunks)).not.toContain("[pdf:");
      expect(JSON.stringify(chunks)).toContain("application/pdf");

      const external = await call.execute("untrusted-id", { ...args, tool: "typed" });
      expect(added).toEqual(["download-id"]);
      expect(JSON.stringify(external.content)).not.toContain(btoa("%PDF-example"));
    } finally {
      await turn.close();
    }
  });
});

describe("read_resource", () => {
  const SKILL = "skill://spc_1/acme/tone/tone/SKILL.md";

  it("reads a skill as text and describes an unsupported binary without its bytes", async () => {
    const stub = mcpStub();
    const turn = await buildTurn(stub, "alpha", undefined);
    try {
      const read = register(turn.extensionFactories).find((t) => t.name === "read_resource")!;
      const md = await read.execute("call_1", { uri: SKILL });
      expect(md.content[0]).toEqual({ type: "text", text: "---\nname: tone\n---\n" });
      const bin = await read.execute("call_2", { uri: SKILL.replace("SKILL.md", "data.bin") });
      expect(JSON.parse(bin.content[0]!.text)).toEqual({
        uri: SKILL.replace("SKILL.md", "data.bin"),
        mimeType: "application/octet-stream",
        size: 2,
        note: "This file format cannot be read by the current model.",
      });
      expect(stub.count("resources/read")).toBe(2);
    } finally {
      await turn.close();
    }
  });

  it("supplies native images and file text for this turn and emits only receipts", async () => {
    const turn = await buildTurn(mcpStub(), "alpha", undefined);
    try {
      const read = register(turn.extensionFactories).find((tool) => tool.name === "read_resource")!;
      for (const [uri, block, privateData] of [
        [
          SKILL.replace("SKILL.md", "sample.png"),
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          "iVBORw0KGgo=",
        ],
        [
          "appfile://private-file",
          { type: "text", text: "the customer contract" },
          "the customer contract",
        ],
      ] as const) {
        const result = await read.execute("file-id", { uri });
        expect(result.content).toContainEqual(block);
        const chunks = new PiChatUiStreamMapper().map({
          type: "tool_execution_end",
          toolName: read.name,
          toolCallId: "file-id",
          result,
          isError: false,
        });
        expect(JSON.stringify(chunks)).toContain(uri);
        expect(JSON.stringify(chunks)).not.toContain(privateData);
      }
    } finally {
      await turn.close();
    }
  });

  it("returns a content over the file reads' inline bounds as its size and a note", async () => {
    const stub = mcpStub();
    const turn = await buildTurn(stub, "alpha", undefined);
    try {
      const read = register(turn.extensionFactories).find((t) => t.name === "read_resource")!;
      const at = (path: string) => SKILL.replace("SKILL.md", path);
      const text = async (path: string) =>
        (await read.execute("call", { uri: at(path) })).content[0]!.text as string;
      // Text is measured in UTF-8 bytes: `é` is two.
      expect(await text(`text-${RESOURCE_TEXT_MAX_BYTES}`)).toBe(
        "é".repeat(RESOURCE_TEXT_MAX_BYTES / 2),
      );
      expect(JSON.parse(await text(`text-${RESOURCE_TEXT_MAX_BYTES + 2}`))).toEqual({
        uri: at(`text-${RESOURCE_TEXT_MAX_BYTES + 2}`),
        mimeType: "text/plain",
        size: RESOURCE_TEXT_MAX_BYTES + 2,
        note: RESOURCE_OVERSIZED_NOTE,
      });
      // A blob is measured in raw bytes, not base64 characters.
      expect(JSON.parse(await text(`blob-${RESOURCE_BLOB_MAX_BYTES}`))).toMatchObject({
        size: RESOURCE_BLOB_MAX_BYTES,
        note: "This file format cannot be read by the current model.",
      });
      expect(JSON.parse(await text(`blob-${RESOURCE_BLOB_MAX_BYTES + 2}`))).toEqual({
        uri: at(`blob-${RESOURCE_BLOB_MAX_BYTES + 2}`),
        mimeType: "application/octet-stream",
        size: RESOURCE_BLOB_MAX_BYTES + 2,
        note: RESOURCE_OVERSIZED_NOTE,
      });
    } finally {
      await turn.close();
    }
  });

  it("surfaces the server's refusal, and refuses a call without a uri before any hop", async () => {
    const stub = mcpStub();
    const turn = await buildTurn(stub, "alpha", undefined);
    try {
      const read = register(turn.extensionFactories).find((t) => t.name === "read_resource")!;
      const refused = await read
        .execute("call_1", { uri: "skill://spc_1/acme/tone/tone/missing.txt" })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(String(refused)).toContain("Resource not found");
      const before = stub.count("resources/read");
      const invalid = await read.execute("call_2", {}).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(invalid)).toContain("`uri` must be a non-empty string");
      expect(stub.count("resources/read")).toBe(before);
    } finally {
      await turn.close();
    }
  });
});
