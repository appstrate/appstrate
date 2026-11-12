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

const ORIGIN = "http://127.0.0.1:1";
const MCP_URL = `${ORIGIN}/api/mcp/o/org_1/s/spc_1?context=injected`;

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
function mcpStub() {
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

function buildTurn(
  stub: ReturnType<typeof mcpStub>,
  surface: string,
  surfaceKey: string | undefined,
  signal = new AbortController().signal,
  listsSkills = false,
) {
  return buildPlatformMcpTools({
    url: MCP_URL,
    headers: { authorization: "Bearer loopback", "x-surface": surface },
    spaceId: "spc_1",
    writeChunk: () => {},
    signal,
    turnBudget: { deadlineAt: Date.now() + 10 * 60_000, stepCount: () => 0 },
    fetch: stub.fetch,
    ...(surfaceKey !== undefined ? { surfaceKey } : {}),
    listsSkills,
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
  const key = platformMcpSurfaceKey(MCP_URL, uniquePermissions());
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
    const key = platformMcpSurfaceKey(MCP_URL, uniquePermissions());

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
    const key = platformMcpSurfaceKey(MCP_URL, uniquePermissions());
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
    const keyA = platformMcpSurfaceKey(MCP_URL, shared);
    const keyB = platformMcpSurfaceKey(MCP_URL, [...shared, "agents:write"]);
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
    const key = platformMcpSurfaceKey(MCP_URL, perms);
    expect(platformMcpSurfaceKey(MCP_URL, [...perms].reverse())).toBe(key);
    expect(platformMcpSurfaceKey(MCP_URL, [...perms, perms[0]!])).toBe(key);
    expect(platformMcpSurfaceKey(MCP_URL, perms.slice(1))).not.toBe(key);
    // `context=injected` drops get_me server-side, so it is part of the surface.
    expect(platformMcpSurfaceKey(`${ORIGIN}/api/mcp/o/org_1`, perms)).not.toBe(key);
    expect(
      platformMcpSurfaceKey("http://other.test/api/mcp/o/org_1?context=injected", perms),
    ).not.toBe(key);
  });

  it("surfaces a failed lazy connect as the tool call's error, retries it, and evicts the entry", async () => {
    const stub = mcpStub();
    const key = platformMcpSurfaceKey(MCP_URL, uniquePermissions());
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

describe("read_resource", () => {
  const SKILL = "skill://spc_1/acme/tone/tone/SKILL.md";

  it("reads a platform resource whole: text as is, a binary file's base64 in blob", async () => {
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
        blob: "AP8=",
      });
      expect(stub.count("resources/read")).toBe(2);
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
      expect(JSON.parse(await text(`blob-${RESOURCE_BLOB_MAX_BYTES}`)).blob).toBe(
        Buffer.alloc(RESOURCE_BLOB_MAX_BYTES).toString("base64"),
      );
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

describe("list_skills", () => {
  it("is registered only on a turn that lists skills", async () => {
    const stub = mcpStub();
    const plain = await buildTurn(stub, "alpha", undefined);
    const listing = await buildTurn(stub, "alpha", undefined, undefined, true);
    try {
      const names = (turn: typeof plain) => register(turn.extensionFactories).map((t) => t.name);
      expect(names(plain)).not.toContain("list_skills");
      expect(names(listing)).toContain("list_skills");
    } finally {
      await plain.close();
      await listing.close();
    }
  });

  it("relays `skills/list` as each skill's id, description, version and uri, drafts on request", async () => {
    const stub = mcpStub();
    const turn = await buildTurn(stub, "alpha", undefined, undefined, true);
    try {
      const list = register(turn.extensionFactories).find((t) => t.name === "list_skills")!;
      const published = await list.execute("call_1", {});
      expect(JSON.parse(published.content[0]!.text)).toEqual([
        {
          id: "@acme/tone",
          description: "Tone.",
          version: "1.2.0",
          uri: "skill://spc_1/acme/tone/tone/SKILL.md",
        },
      ]);
      const drafts = await list.execute("call_2", { definition: "draft" });
      expect(JSON.parse(drafts.content[0]!.text)).toEqual([
        {
          id: "@acme/tone",
          description: "Tone.",
          version: null,
          uri: "skill://spc_1/acme/tone@draft/tone/SKILL.md",
        },
      ]);
      expect(stub.count("skills/list")).toBe(2);
      const invalid = await list.execute("call_3", { definition: "latest" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(invalid)).toContain('`definition` must be "published" or "draft"');
      expect(stub.count("skills/list")).toBe(2);
    } finally {
      await turn.close();
    }
  });
});
