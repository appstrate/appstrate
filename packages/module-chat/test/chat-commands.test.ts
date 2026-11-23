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
import {
  fakePlatformMcp,
  type FakePlatformMcpOptions,
  type FakeSkill,
} from "./fake-platform-mcp.ts";

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

/** `@acme/<name>` in `space`, its SKILL.md listed at `name.length * 100` bytes. */
const skill = (space: string, name: string): FakeSkill => ({
  space,
  id: `@acme/${name}`,
  description: `${name} skill`,
  size: name.length * 100,
});

interface Seen {
  /** Spaces the bearer of each MCP connection allowlisted. */
  spaceIds: (readonly string[] | undefined)[];
  permissions: string[][];
  methods: string[];
  /** Records each message into the fields above. */
  onMethod: NonNullable<FakePlatformMcpOptions["onMethod"]>;
}

function newSeen(): Seen {
  const seen: Seen = {
    spaceIds: [],
    permissions: [],
    methods: [],
    onMethod: async (method, params, req) => {
      seen.methods.push(method);
      if (method === "skills/list" && params?._meta) seen.methods.push("skills/list draft");
      if (method !== "initialize") return;
      const auth = await chatLoopbackStrategy.authenticate({ headers: req.headers } as never);
      seen.spaceIds.push(auth?.spaceIds);
      seen.permissions.push([...(auth?.permissions ?? [])]);
    },
  };
  return seen;
}

/** The scripted platform MCP server, recording into `seen`. */
const mcp = (seen: Seen, opts: Omit<FakePlatformMcpOptions, "onMethod"> = {}) =>
  fakePlatformMcp({ ...opts, onMethod: seen.onMethod });

function appFor(
  reachable: ReachableSpaceGrant[],
  dispatch: ChatPlatformDeps["dispatch"],
  { orgPermissions = [], orgRole = "owner" }: { orgPermissions?: string[]; orgRole?: string } = {},
) {
  const deps = {
    dispatch,
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
    reachableSpaces: async () => ({ spaces: reachable, confined: false, orgPermissions }),
  } as unknown as ChatPlatformDeps;
  const app = new Hono<ChatEnv>();
  app.onError((error, c) => errorHandler(error, c as never));
  app.use("*", async (c, next) => {
    c.set("orgId", "org_1");
    c.set("user", { id: "usr_1", email: "a@b.test", name: "A" });
    c.set("orgRole", orgRole as never);
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
    {
      name: "run-summarizer",
      title: "Summarizer",
      description: "Summarize the inbox",
      _meta: {
        "dev.appstrate/agent": {
          packageId: "@acme/summarizer",
          icon: "lucide:bot",
          color: "teal",
        },
      },
    },
    {
      name: "run-bare",
      _meta: { "dev.appstrate/agent": { packageId: "@acme/bare", icon: null, color: null } },
    },
    // No meta, or a malformed one: no id to seed the colour from, so left out.
    { name: "run-nometa", title: "No meta" },
    {
      name: "run-bad",
      _meta: { "dev.appstrate/agent": { packageId: 3, icon: null, color: null } },
    },
  ];

  it("returns the skills and the agents of every acting space", async () => {
    const seen = newSeen();
    const app = appFor(
      [withPerms(spaceA, "skills:read"), withPerms(spaceB, "skills:read"), viewer],
      mcp(seen, { skills: [skill("spc_a", "tone"), skill("spc_b", "refunds")], prompts: PROMPTS }),
    );
    const res = await get(app);
    expect(res.status).toBe(200);
    const body = chatCommandsSchema.parse(await res.json());
    expect(body).toEqual({
      skills: [
        {
          id: "@acme/refunds",
          name: "refunds",
          description: "refunds skill",
          version: "1.0.0",
          // The listed size of its SKILL.md: no read per skill.
          bytes: 700,
        },
        { id: "@acme/tone", name: "tone", description: "tone skill", version: "1.0.0", bytes: 400 },
      ],
      agents: [
        {
          name: "run-summarizer",
          title: "Summarizer",
          description: "Summarize the inbox",
          packageId: "@acme/summarizer",
          icon: "lucide:bot",
          color: "teal",
        },
        {
          name: "run-bare",
          title: "run-bare",
          description: "",
          packageId: "@acme/bare",
          icon: null,
          color: null,
        },
      ],
    });
    // One connection, over the acting spaces alone, with the caller's own grants.
    expect(seen.spaceIds).toEqual([["spc_a", "spc_b"]]);
    expect(seen.permissions[0]).toContain("skills:read");
  });

  it("reads one space alone with `spaceId`", async () => {
    const seen = newSeen();
    const app = appFor(
      [withPerms(spaceA, "skills:read"), withPerms(spaceB, "skills:read")],
      mcp(seen, { skills: [skill("spc_a", "tone"), skill("spc_b", "refunds")], prompts: [] }),
    );
    const res = await get(app, "?spaceId=spc_b");
    expect(res.status).toBe(200);
    const body = chatCommandsSchema.parse(await res.json());
    expect(body.skills.map((skill) => skill.id)).toEqual(["@acme/refunds"]);
    expect(seen.spaceIds).toEqual([["spc_b"]]);
  });

  it("refuses a space the caller cannot act in, or does not reach, with a 400 naming it", async () => {
    const seen = newSeen();
    const app = appFor([spaceA, viewer], mcp(seen));
    for (const space of ["spc_viewer", "spc_foreign"]) {
      const res = await get(app, `?spaceId=${space}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
    }
    expect(seen.methods).toEqual([]);
  });

  it("answers no skill without `skills:read`, and lists none", async () => {
    const seen = newSeen();
    const app = appFor([spaceA], mcp(seen, { skills: [skill("spc_a", "tone")], prompts: PROMPTS }));
    const body = chatCommandsSchema.parse(await (await get(app)).json());
    expect(body.skills).toEqual([]);
    expect(body.agents.map((a) => a.name)).toEqual(["run-summarizer", "run-bare"]);
    expect(seen.methods).not.toContain("skills/list");
  });

  it("leaves a half that failed empty and keeps the other", async () => {
    const seen = newSeen();
    const app = appFor(
      [withPerms(spaceA, "skills:read")],
      mcp(seen, { skills: [skill("spc_a", "tone")], promptsFail: true }),
    );
    const res = await get(app);
    expect(res.status).toBe(200);
    const body = chatCommandsSchema.parse(await res.json());
    expect(body.agents).toEqual([]);
    expect(body.unavailable).toEqual(["agents"]);
    expect(body.skills.map((skill) => skill.id)).toEqual(["@acme/tone"]);
  });

  for (const definition of ["draft", "published"] as const) {
    it(`identifies a failed ${definition} skills read and recovers on retry`, async () => {
      const opts: FakePlatformMcpOptions = {
        failedSkillList: definition,
        skills: [skill("spc_a", "tone")],
        prompts: PROMPTS,
      };
      const app = appFor([withPerms(spaceA, "skills:read", "skills:write")], fakePlatformMcp(opts));
      const partial = chatCommandsSchema.parse(await (await get(app)).json());
      expect(partial.unavailable).toEqual([
        definition === "draft" ? "draft_skills" : "published_skills",
      ]);
      expect(partial.agents.length).toBeGreaterThan(0);
      delete opts.failedSkillList;
      const refreshed = chatCommandsSchema.parse(await (await get(app)).json());
      expect(refreshed.unavailable).toBeUndefined();
      expect(refreshed.skills.map((s) => s.id)).toContain("@acme/tone");
    });
  }

  it("narrows a `spaceId` read to the limited conversation's grants and gates drafts on `skills:write`", async () => {
    const seen = newSeen();
    // The org-level half is dropped for a limited read; the space-level grants stay.
    const app = appFor(
      [withPerms(spaceA, "skills:read", "skills:write", "agents:write")],
      mcp(seen, { skills: [skill("spc_a", "tone")], prompts: [] }),
      { orgPermissions: ["agents:write"] },
    );
    await get(app, "?spaceId=spc_a");
    expect(seen.permissions[0]).toContain("skills:write");
    expect(seen.permissions[0]).not.toContain("agents:write");
    expect(seen.methods.filter((method) => method === "skills/list draft")).toHaveLength(1);
  });

  it("lists a skill's draft only when a turn would inject it: authoring on and `skills:write`", async () => {
    const reach = [withPerms(spaceA, "skills:read", "skills:write")];
    const listed = async (query: string) => {
      const seen = newSeen();
      const app = appFor(
        reach,
        mcp(seen, { skills: [skill("spc_a", "tone")], drafts: [skill("spc_a", "fresh")] }),
      );
      const res = await get(app, query);
      expect(res.status).toBe(200);
      const body = chatCommandsSchema.parse(await res.json());
      return { ids: body.skills.map((skill) => skill.id), methods: seen.methods };
    };
    for (const query of ["", "?package_authoring=true"]) {
      const on = await listed(query);
      expect(on.ids).toEqual(["@acme/fresh", "@acme/tone"]);
      expect(on.methods).toContain("skills/list draft");
    }
    // Authoring off: the published versions alone, and no draft listing asked for.
    const off = await listed("?package_authoring=false");
    expect(off.ids).toEqual(["@acme/tone"]);
    expect(off.methods).not.toContain("skills/list draft");
  });

  it("refuses a `package_authoring` other than true or false with a 400 naming it", async () => {
    const seen = newSeen();
    const res = await get(appFor([spaceA], mcp(seen)), "?package_authoring=yes");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("package_authoring");
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
    const app = appFor([viewer], mcp(newSeen()));
    expect((await get(app)).status).toBe(403);
  });
});
