// SPDX-License-Identifier: Apache-2.0

/**
 * The tool layer of a conversation: the connection is the organization
 * endpoint, whose space-acting tools each take a `space_id` (a limited
 * conversation's spaces are its origin alone).
 *
 * The local `run_and_wait` resolves the destination before launching, records it, then sends
 * it as `X-Space-Id` on the REST hops. Forwarded tools let the server resolve and record the
 * scope. Cross-space results and live file reads must be recorded before their data is shown.
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";

import {
  ACTIVE_SPACES_META_KEY,
  OPERATION_SPACES_META_KEY,
  SPACE_CHOICE_META_KEY,
} from "@appstrate/core/mcp-spaces";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { buildPlatformMcpTools, type TurnSpaces } from "../src/pi-chat/mcp-tools.ts";

/** Nothing listens here: a hop that escapes the injected fetch throws. */
const ORIGIN = "http://127.0.0.1:1";
const RUN_ID = "run_org_1";
const SPACES = [
  {
    id: "spc_alpha",
    name: "Alpha",
    role: "operator",
    permissions: ["files:read", "mcp:read", "mcp:invoke", "agents:run", "runs:read"],
  },
  {
    id: "spc_beta",
    name: "Beta",
    role: "admin",
    permissions: ["files:read", "mcp:read", "mcp:invoke", "agents:run", "runs:read"],
  },
  {
    id: "spc_runonly",
    name: "Run only",
    role: "custom",
    permissions: ["mcp:read", "mcp:invoke", "agents:run"],
  },
];

/**
 * What the stub platform refuses: a file named `…private…` (a colleague's, behind its container
 * ACL) or `…nowhere…` (missing). Every other file it serves.
 */
const REFUSED = /appfile:\/\/file_\w*(private|nowhere)/;
const PLATFORM_REFUSAL = { code: "not_found", error: "File not found" };

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    spaceChoice?: unknown;
    actedSpaceIds?: readonly string[];
    terminate?: boolean;
  }>;
}

/** Everything the transport saw, in order, with the touches interleaved. */
function transcript(searchKinds?: string[]) {
  const events: string[] = [];
  /** The `searched_spaces` the stub's `search` answers with, when set. */
  const answers: {
    searched?: unknown;
    launchProblem?: Record<string, unknown>;
    invokedSpaces?: string[];
    remote?: Record<string, unknown>;
  } = {};
  const chunks: unknown[] = [];
  const launches: Array<{ spaceHeader: string | null; body: string }> = [];
  const polls: Array<string | null> = [];
  const toolCalls: unknown[] = [];
  const json = (body: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/mcp/")) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const msg = (await req.json()) as { id?: unknown; method?: string; params?: unknown };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown, extra?: Record<string, string>) =>
        json({ jsonrpc: "2.0", id: msg.id, result }, extra);
      if (msg.method === "initialize") {
        return reply(
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "stub", version: "1" },
          },
          { "mcp-session-id": "sess_org" },
        );
      }
      if (msg.method === "tools/list") {
        const spaceId = {
          type: "string",
          enum: SPACES.map((space) => space.id),
        };
        return reply({
          tools: [
            {
              name: "run_and_wait",
              description: "Launch a run.",
              inputSchema: {
                type: "object",
                properties: { kind: { type: "string" }, space_id: spaceId },
                required: ["space_id"],
              },
            },
            {
              name: "read",
              inputSchema: {
                type: "object",
                properties: { uri: { type: "string" }, space_id: spaceId },
                required: ["space_id"],
              },
            },
            {
              name: "search",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  ...(searchKinds
                    ? { kinds: { type: "array", items: { type: "string", enum: searchKinds } } }
                    : {}),
                  space_id: spaceId,
                },
              },
            },
            {
              name: "invoke_operation",
              inputSchema: {
                type: "object",
                properties: { operation_id: { type: "string" }, space_id: spaceId },
                required: ["space_id"],
              },
            },
          ],
        });
      }
      if (msg.method === "tools/call") {
        events.push("tools/call");
        toolCalls.push(msg.params);
        if (answers.remote) return reply(answers.remote);
        if (
          answers.launchProblem &&
          (msg.params as { name?: string }).name === "invoke_operation"
        ) {
          return reply({
            content: [
              { type: "text", text: JSON.stringify({ status: 409, body: answers.launchProblem }) },
            ],
            isError: true,
            _meta: { [ACTIVE_SPACES_META_KEY]: answers.invokedSpaces },
          });
        }
        if (REFUSED.test(JSON.stringify(msg.params))) {
          return reply({
            content: [{ type: "text", text: JSON.stringify(PLATFORM_REFUSAL) }],
            isError: true,
          });
        }
        const uri = (msg.params as { arguments?: { uri?: string } }).arguments?.uri;
        if (uri?.startsWith("skill://")) {
          return reply({
            content: [
              { type: "resource", resource: { uri, mimeType: "text/markdown", text: "# Tone" } },
            ],
          });
        }
        if ((msg.params as { name?: string }).name === "search") {
          const found = {
            operations: { total: 0, items: [] },
            ...(answers.searched !== undefined ? { searched_spaces: answers.searched } : {}),
          };
          return reply({
            content: [{ type: "text", text: JSON.stringify(found) }],
            structuredContent: found,
          });
        }
        return reply({ content: [{ type: "text", text: "{}" }] });
      }
      if (msg.method === "resources/read") {
        events.push("resources/read");
        if (REFUSED.test(JSON.stringify(msg.params))) {
          return json({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32002, message: "not found" },
          });
        }
        return reply({ contents: [{ uri: "x", mimeType: "text/plain", text: "body" }] });
      }
      return reply({});
    }
    if (req.method === "POST" && url.pathname.endsWith("/run")) {
      events.push("launch");
      const body = await req.text();
      launches.push({ spaceHeader: req.headers.get("x-space-id"), body });
      if (answers.launchProblem) return Response.json(answers.launchProblem, { status: 409 });
      if (REFUSED.test(body)) {
        return new Response(JSON.stringify({ status: 404, detail: "File not found" }), {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        });
      }
      return json({ id: RUN_ID, packageId: "@acme/demo", status: "pending" });
    }
    if (req.method === "GET" && url.pathname === `/api/runs/${RUN_ID}`) {
      polls.push(req.headers.get("x-space-id"));
      return json({ id: RUN_ID, packageId: "@acme/demo", status: "success" });
    }
    if (req.method === "GET" && url.pathname === "/api/files") return json({ data: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const lookups: string[] = [];
  return { fetch: fetchImpl, events, launches, polls, toolCalls, lookups, answers, chunks };
}

function organizationOf(
  { events, lookups }: ReturnType<typeof transcript>,
  failingTouch?: string,
): TurnSpaces {
  return {
    spaces: SPACES,
    touch: async (spaceId) => {
      if (spaceId === failingTouch) throw new Error(`cannot record ${spaceId}`);
      events.push(`touch ${spaceId}`);
    },
    // A file id names its space here (`file_beta…` → `spc_beta`); `file_own…` is a file the
    // conversation holds and any other id is missing: both name none.
    fileSpace: async (uri) => {
      lookups.push(uri);
      events.push("lookup");
      const space = uri.match(/^appfile:\/\/file_(alpha|beta|gamma)/)?.[1];
      return space ? `spc_${space}` : undefined;
    },
  };
}

async function tools(
  transport: ReturnType<typeof transcript>,
  failingTouch?: string,
  scope: Partial<Pick<TurnSpaces, "originSpaceId" | "spaceChoice" | "spaces">> = {},
) {
  const built = await buildPlatformMcpTools({
    url: platformMcpUrl(ORIGIN, "org_1"),
    headers: { authorization: "Bearer loopback", "x-org-id": "org_1" },
    organization: { ...organizationOf(transport, failingTouch), ...scope },
    writeChunk: (chunk) => {
      transport.events.push("chunk");
      transport.chunks.push(chunk);
    },
    fileDelivery: { image: false, pdf: false },
    signal: new AbortController().signal,
    turnBudget: { deadlineAt: Date.now() + 10 * 60_000, stepCount: () => 0 },
    fetch: transport.fetch,
  });
  const registered: RegisteredTool[] = [];
  const pi = { registerTool: (tool: RegisteredTool) => registered.push(tool) } as ExtensionAPI;
  for (const factory of built.extensionFactories) factory(pi);
  return { built, tool: (name: string) => registered.find((tool) => tool.name === name)! };
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe("a forwarded tool", () => {
  const remote = (meta: Record<string, unknown>, isError = false) => ({
    content: [{ type: "text", text: "platform response" }],
    _meta: meta,
    isError,
  });

  it("uses the platform's resolved space receipt even when an org-level call named a space", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      transport.answers.remote = remote({ [OPERATION_SPACES_META_KEY]: [] });
      const org = await tool("invoke_operation").execute("c1", {
        operation_id: "listModels",
        space_id: "spc_beta",
      });
      expect(org.actedSpaceIds).toEqual([]);
      transport.answers.remote = remote({ [OPERATION_SPACES_META_KEY]: ["spc_alpha"] });
      const scoped = await tool("invoke_operation").execute("c2", {
        operation_id: "getSpace",
        path_params: { spaceId: "spc_alpha" },
      });
      expect(scoped.actedSpaceIds).toEqual(["spc_alpha"]);
      expect(transport.events).toEqual(["tools/call", "tools/call"]);
    } finally {
      await built.close();
    }
  });

  it("withholds content attributed to a space the turn cannot reach", async () => {
    const transport = transcript();
    transport.answers.remote = remote({ [OPERATION_SPACES_META_KEY]: ["spc_outside"] });
    const { built, tool } = await tools(transport);
    try {
      const refused = await tool("invoke_operation").execute("c", { operation_id: "getSpace" });
      expect(JSON.parse(text(refused)).code).toBe("spaces_not_recorded");
      expect(text(refused)).not.toContain("platform response");
    } finally {
      await built.close();
    }
  });

  it("waits for an explicit user answer to the operation that requested a destination", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    const ids = ["spc_alpha", "spc_beta"];
    try {
      transport.answers.remote = remote({ [SPACE_CHOICE_META_KEY]: ids }, true);
      const refused = await tool("invoke_operation").execute("c", { operation_id: "listAgents" });
      expect(refused.spaceChoice).toEqual({
        tool: "invoke_operation",
        operationId: "listAgents",
        spaceIds: ids,
      });
      expect(refused.terminate).toBe(true);
      const retry = await tool("invoke_operation").execute("again", {
        operation_id: "listAgents",
        space_id: ids[0],
      });
      expect(retry.terminate).toBe(true);
      await tool("run_and_wait").execute("wrong", { kind: "agent", space_id: ids[0] });
      expect(transport.events).toEqual(["tools/call"]);
    } finally {
      await built.close();
    }
  });

  it("does not present a picker for a success, a relayed result or a refusal naming an outside space", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      for (const answer of [
        remote({ [SPACE_CHOICE_META_KEY]: ["spc_beta"] }),
        remote({ [SPACE_CHOICE_META_KEY]: ["spc_beta"], "dev.appstrate/relayed": true }, true),
        remote({ [SPACE_CHOICE_META_KEY]: ["spc_outside"] }, true),
      ]) {
        transport.answers.remote = answer;
        const result = await tool("invoke_operation").execute("c", { operation_id: "listAgents" });
        expect(result.spaceChoice).toBeUndefined();
      }
    } finally {
      await built.close();
    }
  });
});

describe("launch alternatives on a conversation", () => {
  const wanted = { id: "spc_alpha", name: "An active destination" };
  const problem = { code: "missing_integration_connection", active_in_spaces: [wanted] };
  for (const name of ["invoke_operation", "run_and_wait"]) {
    const args =
      name === "invoke_operation"
        ? { operation_id: "runAgent", space_id: "spc_beta" }
        : { kind: "agent", scope: "@acme", name: "demo", space_id: "spc_beta" };
    it(`records the spaces of the ${name} refusal before showing it`, async () => {
      const transport = transcript();
      transport.answers.launchProblem = problem;
      transport.answers.invokedSpaces = [wanted.id];
      const { built, tool } = await tools(transport);
      try {
        const result = await tool(name).execute("c", args);
        expect(JSON.parse(text(result)).body.active_in_spaces).toEqual([wanted]);
        expect(transport.events).toEqual(
          name === "invoke_operation"
            ? ["tools/call", "touch spc_alpha"]
            : ["touch spc_beta", "launch", "touch spc_alpha", "chunk"],
        );
      } finally {
        await built.close();
      }
    });

    it(`withholds the ${name} result and every card if a returned space cannot be recorded`, async () => {
      const transport = transcript();
      transport.answers.launchProblem = problem;
      transport.answers.invokedSpaces = [wanted.id];
      const { built, tool } = await tools(transport, wanted.id);
      try {
        const result = await tool(name).execute("c", args);
        expect(JSON.parse(text(result))).toMatchObject({ code: "spaces_not_recorded" });
        expect(text(result)).not.toContain(wanted.name);
        expect(transport.chunks).toEqual([]);
      } finally {
        await built.close();
      }
    });
  }

  it("suggests only spaces where the chat's local run_and_wait can also read the run", async () => {
    const transport = transcript();
    transport.answers.launchProblem = {
      ...problem,
      active_in_spaces: [wanted, { id: "spc_runonly", name: "Run only" }],
    };
    const { built, tool } = await tools(transport);
    try {
      const result = await tool("run_and_wait").execute("c", {
        kind: "agent",
        scope: "@acme",
        name: "demo",
        space_id: "spc_beta",
      });
      expect(JSON.parse(text(result)).body.active_in_spaces).toEqual([wanted]);
      expect(JSON.stringify(transport.chunks)).not.toContain("Run only");
    } finally {
      await built.close();
    }
  });
});

describe("the conversation's run_and_wait", () => {
  it("takes the space from its arguments, strips it, sends it as X-Space-Id, and records it first", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const result = await tool("run_and_wait").execute("call_1", {
        kind: "agent",
        scope: "@acme",
        name: "demo",
        space_id: "spc_beta",
      });
      expect(JSON.parse(text(result))).toMatchObject({ id: RUN_ID, status: "success" });
      // Recorded before anything was launched.
      expect(transport.events.slice(0, 2)).toEqual(["touch spc_beta", "launch"]);
      // The launch body never carries `space_id`; both REST hops name the space in the header.
      expect(transport.launches[0]!.body).not.toContain("space_id");
      expect(transport.launches[0]!.spaceHeader).toBe("spc_beta");
      expect(transport.polls).toEqual(["spc_beta"]);
    } finally {
      await built.close();
    }
  });

  it("offers eligible destinations only on a genuinely missing space and never launches on the user's behalf", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const run = tool("run_and_wait");
      const unknown = await run.execute("c1", { kind: "agent", space_id: "spc_nope" });
      expect(JSON.parse(text(unknown)).code).toBe("unknown_space");
      expect(unknown.spaceChoice).toBeUndefined();
      const missing = await run.execute("c2", { kind: "agent" });
      expect(JSON.parse(text(missing))).toMatchObject({
        code: "missing_argument",
        accepted: ["spc_alpha", "spc_beta"],
      });
      expect(missing.spaceChoice).toEqual({
        tool: "run_and_wait",
        spaceIds: ["spc_alpha", "spc_beta"],
      });
      expect(missing.terminate).toBe(true);
      await run.execute("c3", { kind: "agent", space_id: "spc_alpha" });
      expect(transport.events).toEqual([]);
    } finally {
      await built.close();
    }
  });

  it("honors the chosen space, refuses a conflicting argument and retains the origin for unrelated choices", async () => {
    const agent = { kind: "agent", scope: "@acme", name: "demo" };
    for (const [chosenTool, expected] of [
      ["run_and_wait", "spc_beta"],
      ["invoke_operation", "spc_alpha"],
    ] as const) {
      const transport = transcript();
      const { built, tool } = await tools(transport, undefined, {
        originSpaceId: "spc_alpha",
        spaceChoice: {
          tool: chosenTool,
          operationId: chosenTool === "invoke_operation" ? "listAgents" : undefined,
          spaceId: "spc_beta",
        },
      });
      try {
        if (chosenTool === "run_and_wait") {
          const conflict = await tool("run_and_wait").execute("c1", {
            ...agent,
            space_id: "spc_alpha",
          });
          expect(JSON.parse(text(conflict)).code).toBe("space_mismatch");
          expect(transport.events).toEqual([]);
        }
        const result = await tool("run_and_wait").execute("c2", agent);
        expect(result.actedSpaceIds).toEqual([expected]);
        expect(transport.events.slice(0, 2)).toEqual([`touch ${expected}`, "launch"]);
      } finally {
        await built.close();
      }
    }
  });

  it("refuses an unlaunchable personal destination for inline instead of trying the origin", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport, undefined, {
      originSpaceId: "spc_alpha",
      spaces: SPACES.map((s) => ({ ...s, personal: s.id === "spc_runonly" })),
    });
    try {
      const result = await tool("run_and_wait").execute("c", { kind: "inline" });
      expect(JSON.parse(text(result)).code).toBe("not_granted");
      expect(result.spaceChoice).toBeUndefined();
      expect(transport.events).toEqual([]);
    } finally {
      await built.close();
    }
  });
});

describe("the conversation's forwarded tools and resources", () => {
  it("forwards the named space or omission to the platform, which records the resolved scope", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("invoke_operation").execute("c1", {
        operation_id: "listAgents",
        space_id: "spc_beta",
      });
      expect(transport.events).toEqual(["tools/call"]);
      expect(transport.toolCalls[0]).toMatchObject({
        arguments: { operation_id: "listAgents", space_id: "spc_beta" },
      });

      transport.events.length = 0;
      await tool("invoke_operation").execute("c2", { operation_id: "listAgents" });
      expect(transport.events).toEqual(["tools/call"]);
    } finally {
      await built.close();
    }
  });

  it("records, after a call that omits an optional space_id, the spaces its result says it read, and none before", async () => {
    const transport = transcript();
    transport.answers.searched = ["spc_alpha"];
    const { built, tool } = await tools(transport);
    try {
      const result = await tool("search").execute("c1", { query: "x" });
      expect(transport.events).toEqual(["tools/call", "touch spc_alpha"]);
      expect(text(result)).toContain("searched_spaces");

      // A result that lists none records none.
      transport.answers.searched = undefined;
      transport.events.length = 0;
      await tool("search").execute("c2", { query: "x" });
      expect(transport.events).toEqual(["tools/call"]);

      // The named space is recorded within the platform's pre-dispatch hook.
      transport.events.length = 0;
      await tool("search").execute("c3", { query: "x", space_id: "spc_beta" });
      expect(transport.events).toEqual(["tools/call"]);

      transport.events.length = 0;
      await tool("invoke_operation").execute("c4", { operation_id: "listAgents" });
      expect(transport.events).toEqual(["tools/call"]);
    } finally {
      await built.close();
    }
  });

  it("withholds the result of a call that read a space outside the turn", async () => {
    const transport = transcript();
    transport.answers.searched = ["spc_alpha", "spc_elsewhere"];
    const { built, tool } = await tools(transport);
    try {
      const result = await tool("search").execute("c1", { query: "x" });
      expect(JSON.parse(text(result))).toMatchObject({ code: "spaces_not_recorded" });
      expect(text(result)).not.toContain("operations");
      expect(transport.events).toEqual(["tools/call"]);
    } finally {
      await built.close();
    }
  });

  it("withholds the result of a call whose read spaces cannot be recorded", async () => {
    const transport = transcript();
    transport.answers.searched = ["spc_beta"];
    const { built, tool } = await tools(transport, "spc_beta");
    try {
      const result = await tool("search").execute("c1", { query: "x" });
      expect(JSON.parse(text(result))).toMatchObject({ code: "spaces_not_recorded" });
      expect(text(result)).not.toContain("operations");
    } finally {
      await built.close();
    }
  });

  it("keeps the text of a skill read through `read` in the replay", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const result = (await tool("read").execute("c1", {
        uri: "skill://spc_beta/acme/tone/tone/SKILL.md",
        space_id: "spc_beta",
      })) as { content: Array<{ text?: string }>; persistedContent?: unknown };
      expect(result.content.map((block) => block.text).join("")).toContain("# Tone");
      // No receipt stands in for it: the stored content is the text itself.
      expect(result.persistedContent).toBeUndefined();
    } finally {
      await built.close();
    }
  });

  it("records the space of a resource URI it can place, before the read", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("read_resource").execute("c1", {
        uri: "skill://spc_beta/acme/tone/tone/SKILL.md",
      });
      expect(transport.events).toEqual(["touch spc_beta", "resources/read"]);

      transport.events.length = 0;
      await tool("read_resource").execute("c2", { uri: "appfile://file_own00001" });
      expect(transport.events).toEqual(["lookup", "resources/read"]);
    } finally {
      await built.close();
    }
  });

  it("refuses a resource of a space outside the turn's like a call naming it: unread, unrecorded", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const refused = JSON.parse(
        text(
          await tool("read_resource").execute("c1", {
            uri: "skill://spc_nope/acme/tone/tone/SKILL.md",
          }),
        ),
      );
      expect(refused).toMatchObject({
        code: "unknown_space",
        accepted: SPACES.map((space) => space.id),
      });
      expect(transport.events).toEqual([]);
    } finally {
      await built.close();
    }
  });
});

describe("the files a call names", () => {
  it("leaves forwarded file arguments to the platform and records only the local launch space", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("read").execute("c1", {
        uri: "appfile://file_beta0001",
        space_id: "spc_alpha",
        again: ["appfile://file_gamma001", { deep: "appfile://file_own00001" }],
      });
      await tool("run_and_wait").execute("c2", {
        kind: "agent",
        scope: "@acme",
        name: "demo",
        space_id: "spc_beta",
        input: { doc: "appfile://file_alpha001" },
      });
      expect(transport.events.slice(0, 3)).toEqual(["tools/call", "touch spc_beta", "launch"]);
      expect(transport.events).not.toContain("touch spc_gamma");
      expect(transport.lookups).toEqual([]);
    } finally {
      await built.close();
    }
  });

  it("records the space of a file resource of the turn once it is read", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("read_resource").execute("c1", { uri: "appfile://file_beta0001" });
      expect(transport.events).toEqual(["lookup", "resources/read", "touch spc_beta"]);
    } finally {
      await built.close();
    }
  });

  it("forwards its own, an outside or a missing file unrecorded, the platform's refusal as is", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("read_resource").execute("c1", { uri: "appfile://file_own00001" });
      await tool("read_resource").execute("c2", { uri: "appfile://file_gamma001" });
      await expect(
        tool("read_resource").execute("c3", { uri: "appfile://file_nowhere01" }),
      ).rejects.toThrow();
      expect(transport.events).toEqual([
        "lookup",
        "resources/read",
        "lookup",
        "resources/read",
        "lookup",
        "resources/read",
      ]);
    } finally {
      await built.close();
    }
  });

  it("records nothing when the file is gone between the space lookup and the read (not_found)", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await expect(
        tool("read_resource").execute("c1", { uri: "appfile://file_beta_private" }),
      ).rejects.toThrow();
      expect(transport.events).toEqual(["lookup", "resources/read"]);
    } finally {
      await built.close();
    }
  });

  it("fails a file read whose space cannot be recorded: its content is not returned", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport, "spc_beta");
    try {
      await expect(
        tool("read_resource").execute("c1", { uri: "appfile://file_beta0001" }),
      ).rejects.toThrow("cannot record spc_beta");
      expect(transport.events).toEqual(["lookup", "resources/read"]);
    } finally {
      await built.close();
    }
  });
});
