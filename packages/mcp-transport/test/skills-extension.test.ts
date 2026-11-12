// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ErrorCode, McpError, ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createInProcessPair,
  createMcpHttpClient,
  createMcpServer,
  parseMcpPost,
  serveStatelessPost,
  wrapClient,
  type AppstrateResourceProvider,
  type AppstrateSkillProvider,
} from "../src/index.ts";
import { handlerFetch } from "../src/testing.ts";
import type { SkillEntry } from "@appstrate/core/skill-uri";

const ENTRY: SkillEntry = {
  uri: "skill://space/acme/refunds/refunds/SKILL.md",
  frontmatter: { name: "refunds", description: "Process refunds" },
  resources: [
    {
      uri: "skill://space/acme/refunds/refunds/SKILL.md",
      digest: `sha256:${"0".repeat(64)}`,
      size: 42,
    },
  ],
};

const resources: AppstrateResourceProvider = {
  read: (uri) => ({ contents: [{ uri, mimeType: "text/markdown", text: "" }] }),
};

const skills = {
  list: () => [ENTRY],
  get: (uri: string) => {
    if (uri === ENTRY.uri) return ENTRY;
    throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${uri}`);
  },
};

describe("createMcpServer — skills extension (SEP-2640)", () => {
  it("declares the extension next to the resources capability", async () => {
    const pair = await createInProcessPair([], { resources, skills });
    try {
      const caps = pair.client.getServerCapabilities();
      expect(caps?.resources).toBeDefined();
      expect(caps?.extensions?.["io.modelcontextprotocol/skills"]).toEqual({});
    } finally {
      await pair.close();
    }
  });

  it("does not declare the extension without a skill provider", async () => {
    const pair = await createInProcessPair([], { resources });
    try {
      expect(pair.client.getServerCapabilities()?.extensions).toBeUndefined();
    } finally {
      await pair.close();
    }
  });

  it("answers skills/list and skills/get with no attribute of a later protocol revision", async () => {
    const pair = await createInProcessPair([], { resources, skills });
    try {
      const list = await pair.client.request({ method: "skills/list", params: {} }, ResultSchema);
      expect(list).toEqual({ skills: [ENTRY] });
      const get = await pair.client.request(
        { method: "skills/get", params: { uri: ENTRY.uri } },
        ResultSchema,
      );
      expect(get).toEqual({ skill: ENTRY });
    } finally {
      await pair.close();
    }
  });

  it("refuses skills/get without a uri or for an unknown skill with -32602", async () => {
    const pair = await createInProcessPair([], { resources, skills });
    try {
      for (const params of [{}, { uri: "skill://space/acme/other/other/SKILL.md" }]) {
        const err = await pair.client.request({ method: "skills/get", params }, ResultSchema).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      }
    } finally {
      await pair.close();
    }
  });

  it("keeps answering unknown methods with -32601", async () => {
    const pair = await createInProcessPair([], { resources, skills });
    try {
      const err = await pair.client
        .request({ method: "skills/unknown", params: {} }, ResultSchema)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.MethodNotFound);
    } finally {
      await pair.close();
    }
  });

  it("rejects a skill provider without a resource provider", () => {
    expect(() => createMcpServer([], undefined, { skills })).toThrow(
      "the skills extension requires a resource provider",
    );
  });
});

/** A stateless HTTP server on the v1 SDK answering with `skills`. */
function skillsFetch(provider: AppstrateSkillProvider): typeof fetch {
  return handlerFetch(async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.arrayBuffer();
    return serveStatelessPost(
      createMcpServer([], undefined, { resources, skills: provider }),
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      }),
      new Request(request.url, { method: "POST", headers: request.headers, body }),
      parseMcpPost(body),
    );
  });
}

describe("AppstrateMcpClient.listSkills", () => {
  /** A provider listing `ENTRY`, recording the `_meta` of each `skills/list`. */
  const recording = () => {
    const metas: unknown[] = [];
    const provider: AppstrateSkillProvider = {
      list: (extra) => {
        metas.push(extra._meta);
        return [ENTRY];
      },
      get: skills.get,
    };
    return { provider, metas };
  };

  it("lists the entries over HTTP, sending `meta` as the request `_meta`", async () => {
    const { provider, metas } = recording();
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: skillsFetch(provider),
    });
    try {
      expect(await client.listSkills()).toEqual({ skills: [ENTRY] });
      expect(await client.listSkills({ meta: { "dev.appstrate/definition": "draft" } })).toEqual({
        skills: [ENTRY],
      });
      expect(metas).toEqual([undefined, { "dev.appstrate/definition": "draft" }]);
    } finally {
      await client.close();
    }
  });

  it("lists the entries over an in-process pair", async () => {
    const { provider, metas } = recording();
    const pair = await createInProcessPair([], { resources, skills: provider });
    const client = wrapClient(pair.client, pair);
    try {
      expect(await client.listSkills({ meta: { k: "v" } })).toEqual({ skills: [ENTRY] });
      expect(metas).toEqual([{ k: "v" }]);
    } finally {
      await client.close();
    }
  });

  /** {@link skillsFetch}, with `skills/list` answered by `page(params)` instead. */
  const pagedFetch = (page: (params: Record<string, unknown>) => unknown): typeof fetch => {
    const server = skillsFetch(skills);
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.clone().text();
      const message = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (message.method !== "skills/list") return server(request);
      const result = page((message.params as Record<string, unknown>) ?? {});
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    }) as typeof fetch;
  };

  it("follows `nextCursor` to the last page, sending `meta` on each", async () => {
    const seen: unknown[] = [];
    const second = { ...ENTRY, uri: ENTRY.uri.replace("tone", "other") };
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: pagedFetch((params) => {
        seen.push(params);
        return params.cursor === "p2"
          ? { skills: [second] }
          : { skills: [ENTRY], nextCursor: "p2" };
      }),
    });
    try {
      expect(await client.listSkills({ meta: { k: "v" } })).toEqual({ skills: [ENTRY, second] });
      expect(seen).toEqual([{ _meta: { k: "v" } }, { cursor: "p2", _meta: { k: "v" } }]);
    } finally {
      await client.close();
    }
  });

  it("refuses a server repeating its cursor, with no partial list", async () => {
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: pagedFetch(() => ({ skills: [ENTRY], nextCursor: "again" })),
    });
    try {
      await expect(client.listSkills()).rejects.toThrow("skills/list repeated its cursor 'again'");
    } finally {
      await client.close();
    }
  });

  it("accepts an entry whose `resources` is `dynamic`", async () => {
    const dynamic = { ...ENTRY, resources: "dynamic" };
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: pagedFetch(() => ({ skills: [ENTRY, dynamic] })),
    });
    try {
      expect(await client.listSkills()).toEqual({ skills: [ENTRY, dynamic] });
    } finally {
      await client.close();
    }
  });

  it("fails the whole list on a malformed entry", async () => {
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: skillsFetch({
        list: () =>
          [ENTRY, { ...ENTRY, resources: [{ ...ENTRY.resources[0]!, size: "42" }] }] as never,
        get: skills.get,
      }),
    });
    try {
      await expect(client.listSkills()).rejects.toThrow("skills/list entry 1 is not a skill entry");
    } finally {
      await client.close();
    }
  });
});
