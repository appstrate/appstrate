// SPDX-License-Identifier: Apache-2.0

/**
 * The agent launch prompts, with the routes faked behind the dispatch: which
 * spaces and agents get a prompt, how names collide, and what `prompts/get`
 * answers. The routes' own guards are the integration suite's.
 */

import { describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import {
  buildAgentPromptProvider,
  type PromptSpace,
} from "../../../../src/modules/mcp/agent-prompts.ts";

const noExtra = {} as unknown as AppstrateRequestExtra;

interface FakeAgent {
  id: string;
  /** Absent: nothing published, the detail route answers 404 at `latest`. */
  version?: string;
  display_name?: string;
  description?: string;
  input?: Record<string, unknown>;
}

const EMPTY_INPUT = { schema: { type: "object", properties: {} }, values: {}, locked_fields: [] };

/** `GET /api/agents` and the agent detail per space, keyed by the `x-space-id` header. */
function fakeDispatch(agentsBySpace: Record<string, FakeAgent[]>) {
  const requests: { spaceId: string | null; path: string }[] = [];
  const dispatch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const spaceId = request.headers.get("x-space-id");
    requests.push({ spaceId, path: `${url.pathname}${url.search}` });
    const agents = agentsBySpace[spaceId ?? ""];
    if (!agents) return Response.json({ code: "forbidden" }, { status: 403 });
    if (url.pathname === "/api/agents") {
      return Response.json({ object: "list", data: agents.map(({ id }) => ({ id })) });
    }
    const match = /^\/api\/packages\/agents\/(@[^/]+)\/([^/]+)$/.exec(url.pathname);
    const agent = agents.find((a) => match && a.id === `${match[1]}/${match[2]}`);
    if (!agent?.version) return Response.json({ code: "agent_not_found" }, { status: 404 });
    return Response.json({
      id: agent.id,
      version: agent.version,
      display_name: agent.display_name,
      description: agent.description ?? "",
      input: agent.input ?? EMPTY_INPUT,
    });
  };
  return { dispatch, requests };
}

const space = (id: string, name: string, runs = true): PromptSpace => ({
  id,
  name,
  surface: { runs },
});

function provider(spaces: PromptSpace[], agentsBySpace: Record<string, FakeAgent[]>) {
  const fake = fakeDispatch(agentsBySpace);
  return {
    prompts: buildAgentPromptProvider({
      origin: "http://localhost:3000",
      authHeaders: new Headers({ authorization: "Bearer test" }),
      dispatch: fake.dispatch,
      spaces,
    }),
    requests: fake.requests,
  };
}

async function textOf(
  prompts: ReturnType<typeof provider>["prompts"],
  name: string,
  args: Record<string, string> = {},
) {
  const result = await prompts.get(name, args, noExtra);
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]!.role).toBe("user");
  const content = result.messages[0]!.content;
  if (content.type !== "text") throw new Error("expected a text message");
  return content.text;
}

describe("agent prompts — prompts/list", () => {
  it("lists one prompt per published agent, only in spaces where the caller can run", async () => {
    const { prompts, requests } = provider(
      [space("spc_a", "Alpha"), space("spc_b", "Beta", false)],
      {
        spc_a: [
          { id: "@acme/writer", version: "1.2.0", display_name: "Writer", description: "Writes." },
          { id: "@acme/unpublished" },
        ],
        spc_b: [{ id: "@acme/reader", version: "1.0.0" }],
      },
    );
    const listed = await prompts.list(noExtra);
    expect(listed).toEqual([
      {
        name: "run-writer",
        title: "Writer",
        description: 'Launches a metered run of the Appstrate agent "Writer": Writes.',
        arguments: [expect.objectContaining({ name: "request", required: false })],
      },
    ]);
    // The space without `run_and_wait` is never read.
    expect(requests.some((r) => r.spaceId === "spc_b")).toBe(false);
  });

  it("lists nothing when the caller can run in no space", async () => {
    const { prompts, requests } = provider([space("spc_a", "Alpha", false)], {
      spc_a: [{ id: "@acme/writer", version: "1.0.0" }],
    });
    expect(await prompts.list(noExtra)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("lists nothing for a space whose agent listing the route refuses", async () => {
    const { prompts } = provider([space("spc_denied", "Denied")], {});
    expect(await prompts.list(noExtra)).toEqual([]);
  });

  it("names the same agent in a second space run-<space>-<name>, another agent run-<scope>-<name>", async () => {
    const { prompts } = provider([space("spc_a", "Alpha"), space("spc_b", "Beta Team")], {
      spc_a: [{ id: "@acme/writer", version: "1.0.0" }],
      spc_b: [
        { id: "@acme/writer", version: "1.0.0" },
        { id: "@other/writer", version: "2.0.0" },
      ],
    });
    const names = (await prompts.list(noExtra)).map((p) => p.name);
    expect(names).toEqual(["run-writer", "run-beta-team-writer", "run-other-writer"]);
    expect(await textOf(prompts, "run-beta-team-writer")).toContain('"space_id":"spc_b"');
    expect(await textOf(prompts, "run-other-writer")).toContain('"scope":"@other"');
  });
});

describe("agent prompts — prompts/get", () => {
  const fileInput = {
    schema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        tone: { type: "string" },
        secret: { type: "string" },
        doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
      },
      required: ["topic"],
    },
    values: { tone: "STORED-TONE-VALUE", secret: "STORED-SECRET-VALUE" },
    locked_fields: ["secret"],
  };

  it("renders the launch instructions with the contract and the request", async () => {
    const { prompts } = provider([space("spc_a", "Alpha")], {
      spc_a: [{ id: "@acme/writer", version: "1.2.0", input: fileInput }],
    });
    const text = await textOf(prompts, "run-writer", { request: "a post about MCP" });
    expect(text).toContain("# Run Appstrate agent `@acme/writer` version `1.2.0`");
    expect(text).toContain(
      '{"kind":"agent","scope":"@acme","name":"writer","version":"1.2.0","input":{},"space_id":"spc_a"}',
    );
    expect(text).toContain("this server's `run_and_wait` tool");
    expect(text).not.toContain("mcp__");
    expect(text).toContain("`createUpload`");
    expect(text).toContain('"locked": [\n      "secret"\n    ]');
    expect(text).toContain('"prefilled": [\n      "tone"\n    ]');
    expect(text.endsWith("## Request\n\na post about MCP\n")).toBe(true);
    // Which fields hold a stored value, never the value.
    expect(text).not.toContain("STORED-TONE-VALUE");
    expect(text).not.toContain("STORED-SECRET-VALUE");
  });

  it("omits the upload step without a file field and marks an absent request", async () => {
    const { prompts } = provider([space("spc_a", "Alpha")], {
      spc_a: [{ id: "@acme/writer", version: "1.0.0" }],
    });
    const text = await textOf(prompts, "run-writer");
    expect(text).not.toContain("createUpload");
    expect(text.endsWith("## Request\n\n(none)\n")).toBe(true);
  });

  it("answers an unknown and an unpublished agent with the same invalid-params error", async () => {
    const { prompts } = provider([space("spc_a", "Alpha"), space("spc_b", "Beta", false)], {
      spc_a: [{ id: "@acme/unpublished" }],
      spc_b: [{ id: "@acme/reader", version: "1.0.0" }],
    });
    for (const name of ["run-unpublished", "run-reader", "run-nothing"]) {
      const error = await prompts.get(name, {}, noExtra).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((error as McpError).message).toContain(`Invalid prompt name: ${name}`);
    }
  });
});
