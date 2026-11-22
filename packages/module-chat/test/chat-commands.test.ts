// SPDX-License-Identifier: Apache-2.0

/** `GET /api/orgs/:orgId/chat/commands`: the composer's skills and agents, read over MCP. */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "../../../apps/api/src/middleware/error-handler.ts";
import { createChatRouter } from "../src/routes.ts";
import { chatCommandsSchema } from "../src/commands.ts";
import type { ChatEnv } from "../src/prompt.ts";
import type { ChatPlatformDeps } from "../src/platform-services.ts";
import type { ReachableSpaceGrant } from "@appstrate/core/module";
import { chatLoopbackStrategy } from "../src/loopback-auth.ts";
import { reachableSpace } from "./reachable-space.ts";

const ACTING = ["chat:read", "chat:write", "mcp:read"];
const spaceA = reachableSpace({ id: "spc_a", name: "A", role: "owner", permissions: ACTING });
const spaceB = reachableSpace({ id: "spc_b", name: "B", role: "owner", permissions: ACTING });
const viewer = reachableSpace({
  id: "spc_viewer",
  name: "Viewer",
  role: "viewer",
  permissions: ["chat:read", "mcp:read"],
});
const withPerms = (space: ReachableSpaceGrant, ...extra: string[]): ReachableSpaceGrant => ({
  ...space,
  permissions: [...space.permissions, ...extra],
});

const digest = `sha256:${"0".repeat(64)}`;
const skillEntry = (spaceId: string, name: string) => {
  const uri = `skill://${spaceId}/acme/${name}/${name}/SKILL.md`;
  return {
    uri,
    frontmatter: { name, description: `${name} skill`, metadata: { version: "1.0.0" } },
    resources: [{ uri, digest, size: 1 }],
  };
};

interface Seen {
  /** Spaces the bearer of each MCP connection allowlisted. */
  spaceIds: (readonly string[] | undefined)[];
  permissions: string[][];
  methods: string[];
}

/** A scripted platform MCP server: the skills of each space and the agent prompts. */
function mcpDispatch(
  seen: Seen,
  opts: { skills?: Record<string, string[]>; prompts?: unknown[]; promptsFail?: boolean } = {},
) {
  return async (req: Request): Promise<Response> => {
    const message = (await req.json()) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    seen.methods.push(message.method);
    const result = (value: unknown) =>
      Response.json({ jsonrpc: "2.0", id: message.id, result: value });
    switch (message.method) {
      case "initialize": {
        const auth = await chatLoopbackStrategy.authenticate({ headers: req.headers } as never);
        seen.spaceIds.push(auth?.spaceIds);
        seen.permissions.push([...(auth?.permissions ?? [])]);
        return result({
          protocolVersion: message.params?.protocolVersion,
          capabilities: {
            resources: {},
            prompts: {},
            extensions: { "io.modelcontextprotocol/skills": {} },
          },
          serverInfo: { name: "fake-platform", version: "1.0.0" },
        });
      }
      case "skills/list": {
        const meta = message.params?._meta as Record<string, unknown> | undefined;
        if (meta) return result({ skills: [] });
        return result({
          skills: Object.entries(opts.skills ?? {}).flatMap(([spaceId, names]) =>
            names.map((name) => skillEntry(spaceId, name)),
          ),
        });
      }
      case "prompts/list":
        if (opts.promptsFail) {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "boom" },
          });
        }
        return result({ prompts: opts.prompts ?? [] });
      default:
        return new Response(null, { status: 202 });
    }
  };
}

function appFor(reachable: ReachableSpaceGrant[], dispatch: ChatPlatformDeps["dispatch"]) {
  const deps = {
    dispatch,
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
    reachableSpaces: async () => ({ spaces: reachable, confined: false, orgPermissions: [] }),
  } as unknown as ChatPlatformDeps;
  const app = new Hono<ChatEnv>();
  app.onError((error, c) => errorHandler(error, c as never));
  app.use("*", async (c, next) => {
    c.set("orgId", "org_1");
    c.set("user", { id: "usr_1", email: "a@b.test", name: "A" });
    c.set("orgRole", "owner");
    c.set("requestId", "req_test");
    return next();
  });
  app.route("/", createChatRouter(deps));
  return app;
}

const get = (app: Hono<ChatEnv>, query = "") =>
  app.request(`/api/orgs/org_1/chat/commands${query}`);

describe("GET /api/orgs/:orgId/chat/commands", () => {
  const PROMPTS = [
    { name: "run-summarizer", title: "Summarizer", description: "Summarize the inbox" },
    { name: "run-bare" },
  ];

  it("returns the skills and the agents of every acting space", async () => {
    const seen: Seen = { spaceIds: [], permissions: [], methods: [] };
    const app = appFor(
      [withPerms(spaceA, "skills:read"), withPerms(spaceB, "skills:read"), viewer],
      mcpDispatch(seen, { skills: { spc_a: ["tone"], spc_b: ["refunds"] }, prompts: PROMPTS }),
    );
    const res = await get(app);
    expect(res.status).toBe(200);
    const body = chatCommandsSchema.parse(await res.json());
    expect(body).toEqual({
      skills: [
        { id: "@acme/refunds", name: "refunds", description: "refunds skill", version: "1.0.0" },
        { id: "@acme/tone", name: "tone", description: "tone skill", version: "1.0.0" },
      ],
      agents: [
        { name: "run-summarizer", title: "Summarizer", description: "Summarize the inbox" },
        { name: "run-bare", title: "run-bare", description: "" },
      ],
    });
    // One connection, over the acting spaces alone, with the caller's own grants.
    expect(seen.spaceIds).toEqual([["spc_a", "spc_b"]]);
    expect(seen.permissions[0]).toContain("skills:read");
  });

  it("reads one space alone with `spaceId`", async () => {
    const seen: Seen = { spaceIds: [], permissions: [], methods: [] };
    const app = appFor(
      [withPerms(spaceA, "skills:read"), withPerms(spaceB, "skills:read")],
      mcpDispatch(seen, { skills: { spc_a: ["tone"], spc_b: ["refunds"] }, prompts: [] }),
    );
    const res = await get(app, "?spaceId=spc_b");
    expect(res.status).toBe(200);
    const body = chatCommandsSchema.parse(await res.json());
    expect(body.skills.map((skill) => skill.id)).toEqual(["@acme/refunds"]);
    expect(seen.spaceIds).toEqual([["spc_b"]]);
  });

  it("refuses a space the caller cannot act in, or does not reach, with a 400 naming it", async () => {
    const seen: Seen = { spaceIds: [], permissions: [], methods: [] };
    const app = appFor([spaceA, viewer], mcpDispatch(seen));
    for (const space of ["spc_viewer", "spc_foreign"]) {
      const res = await get(app, `?spaceId=${space}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
    }
    expect(seen.methods).toEqual([]);
  });

  it("answers no skill without `skills:read`, and lists none", async () => {
    const seen: Seen = { spaceIds: [], permissions: [], methods: [] };
    const app = appFor(
      [spaceA],
      mcpDispatch(seen, { skills: { spc_a: ["tone"] }, prompts: PROMPTS }),
    );
    const body = chatCommandsSchema.parse(await (await get(app)).json());
    expect(body.skills).toEqual([]);
    expect(body.agents).toHaveLength(2);
    expect(seen.methods).not.toContain("skills/list");
  });

  it("answers no agent when the server serves none", async () => {
    const seen: Seen = { spaceIds: [], permissions: [], methods: [] };
    const app = appFor(
      [withPerms(spaceA, "skills:read")],
      mcpDispatch(seen, { skills: { spc_a: ["tone"] }, prompts: [] }),
    );
    const body = chatCommandsSchema.parse(await (await get(app)).json());
    expect(body.agents).toEqual([]);
    expect(body.skills).toHaveLength(1);
  });

  it("leaves a half that failed empty and keeps the other", async () => {
    const seen: Seen = { spaceIds: [], permissions: [], methods: [] };
    const app = appFor(
      [withPerms(spaceA, "skills:read")],
      mcpDispatch(seen, { skills: { spc_a: ["tone"] }, promptsFail: true }),
    );
    const res = await get(app);
    expect(res.status).toBe(200);
    const body = chatCommandsSchema.parse(await res.json());
    expect(body.agents).toEqual([]);
    expect(body.skills.map((skill) => skill.id)).toEqual(["@acme/tone"]);
  });

  it("narrows a `spaceId` read to the limited conversation's grants and gates drafts on `skills:write`", async () => {
    const seen: Seen = { spaceIds: [], permissions: [], methods: [] };
    const drafts: unknown[] = [];
    const dispatch = mcpDispatch(seen, { skills: { spc_a: ["tone"] }, prompts: [] });
    const spy: ChatPlatformDeps["dispatch"] = async (req) => {
      const clone = req.clone();
      const message = (await clone.json()) as { method: string; params?: { _meta?: unknown } };
      if (message.method === "skills/list" && message.params?._meta)
        drafts.push(message.params._meta);
      return dispatch(req);
    };
    // The org-level half is dropped for a limited read; the space-level grants stay.
    const reach = [withPerms(spaceA, "skills:read", "skills:write", "agents:write")];
    const app = (() => {
      const deps = {
        dispatch: spy,
        rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
        reachableSpaces: async () => ({
          spaces: reach,
          confined: false,
          orgPermissions: ["agents:write"],
        }),
      } as unknown as ChatPlatformDeps;
      const hono = new Hono<ChatEnv>();
      hono.onError((error, c) => errorHandler(error, c as never));
      hono.use("*", async (c, next) => {
        c.set("orgId", "org_1");
        c.set("user", { id: "usr_1", email: "a@b.test", name: "A" });
        c.set("requestId", "req_test");
        return next();
      });
      hono.route("/", createChatRouter(deps));
      return hono;
    })();
    await get(app, "?spaceId=spc_a");
    expect(seen.permissions[0]).toContain("skills:write");
    expect(seen.permissions[0]).not.toContain("agents:write");
    expect(drafts).toHaveLength(1);
    // Without `skills:write` the drafts are still read (the turn does too) but never listed.
    const readOnly = appFor(
      [withPerms(spaceA, "skills:read")],
      mcpDispatch(seen, { skills: { spc_a: ["tone"] }, prompts: [] }),
    );
    expect(chatCommandsSchema.parse(await (await get(readOnly)).json()).skills).toHaveLength(1);
  });

  it("answers 502 when the MCP server cannot be reached, not an empty list", async () => {
    const app = appFor(
      [withPerms(spaceA, "skills:read")],
      async () => new Response("down", { status: 500 }),
    );
    const res = await get(app);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("bad_gateway");
  });

  it("is refused without an acting space", async () => {
    const app = appFor([viewer], mcpDispatch({ spaceIds: [], permissions: [], methods: [] }));
    expect((await get(app)).status).toBe(403);
  });
});
