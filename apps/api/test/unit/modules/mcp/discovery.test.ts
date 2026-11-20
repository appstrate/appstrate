// SPDX-License-Identifier: Apache-2.0

/**
 * `search` and `describe` over the kinds beside operations: agents, read from the agent routes
 * behind the dispatch, and skills, read from the Skills extension's reader. The routes' guards
 * and the reader's ACL are the integration suites'; here, what each kind lists and describes, how
 * `best_match` ranks across kinds, and when a kind is declared.
 */

import { describe, expect, it } from "bun:test";
import type { SkillEntry } from "@appstrate/core/skill-uri";
import { deriveMcpSurface, type Dispatch } from "../../../../src/modules/mcp/tools.ts";
import { operationIdGranted } from "../../../../src/modules/mcp/catalog.ts";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";
import { noExtra, parseResult, toolsFor } from "./helpers.ts";

await registerTestPlatformApp();

const READER = ["mcp:read", "mcp:invoke", "agents:read", "agents:run", "runs:read", "skills:read"];
const SPACE = "spc_1";

const skillEntry = (scope: string, name: string, description: string): SkillEntry => ({
  uri: `skill://${SPACE}/${scope}/${name}/${name}/SKILL.md`,
  frontmatter: { name, description },
  resources: [
    { uri: `skill://${SPACE}/${scope}/${name}/${name}/SKILL.md`, digest: "sha256:0", size: 1 },
  ],
});

const TONE = skillEntry("acme", "tone", "Sets the tone of a reply.");
const ELSEWHERE: SkillEntry = {
  ...skillEntry("acme", "other", "Another space's skill."),
  uri: "skill://spc_2/acme/other/other/SKILL.md",
};

const AGENTS = [
  {
    id: "@acme/invoice-sorter",
    display_name: "Invoice sorter",
    description: "Sorts invoices.",
    published: true,
  },
  { id: "@acme/draft-only", display_name: "", description: "Not yet published.", published: false },
];

function makeTools(
  permissions: string[],
  agentsStatus = 200,
  /** Org-wide: spaces whose agents route refuses. */
  refusingSpaces: string[] = [],
  orgWide = false,
) {
  const requests: string[] = [];
  const dispatch: Dispatch = async (req) => {
    const url = new URL(req.url);
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/agents") {
      return agentsStatus === 200
        ? Response.json({ object: "list", data: AGENTS, hasMore: false })
        : Response.json({ code: "forbidden" }, { status: agentsStatus });
    }
    if (url.pathname === "/api/packages/agents/@acme/invoice-sorter") {
      return Response.json({
        id: "@acme/invoice-sorter",
        display_name: "Invoice sorter",
        description: "Sorts invoices.",
        version: "1.2.0",
        definition: "published",
        input: { schema: { type: "object", properties: { month: { type: "string" } } } },
        prompt: "the agent's own prompt, which a launch does not need",
      });
    }
    return Response.json({ code: "agent_not_found" }, { status: 404 });
  };
  const surface = deriveMcpSurface(
    new Set(permissions),
    undefined,
    { type: "user", id: "user_1" },
    true,
    {
      credentialProxyOpen: true,
    },
  );
  const space = (id: string) => ({
    id,
    name: id,
    role: "admin",
    permissions: new Set(permissions),
    surface,
  });
  const orgSpaces = orgWide
    ? {
        reachable: [space(SPACE), space("spc_2")],
        current: space(SPACE),
        dispatchIn: (spaceId: string): Dispatch =>
          refusingSpaces.includes(spaceId)
            ? async () => Response.json({ code: "forbidden" }, { status: 403 })
            : dispatch,
      }
    : undefined;
  const tools = toolsFor({
    origin: "https://test.local",
    orgSpaces,
    authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
    permissions: new Set(permissions),
    ceiling: undefined,
    dispatch,
    actor: { type: "user", id: "user_1" },
    scope: { orgId: "org_1", spaceId: SPACE },
    skills: {
      list: async () => [TONE, ELSEWHERE],
      entry: async (uri) => [TONE, ELSEWHERE].find((entry) => entry.uri === uri) ?? null,
      read: async () => {
        throw new Error("not read here");
      },
    },
    fileAccess: async () => ({ grants: [] }),
    authorizeBundle: async () => {},
    placeRootAs: async () => null,
    requestId: "req_test",
    followRunLogs: () => () => {},
  });
  const byName = new Map(tools.map((t) => [t.descriptor.name, t]));
  const call = async (name: string, args: Record<string, unknown>) =>
    parseResult(await byName.get(name)!.handler(args, noExtra));
  return { byName, call, requests };
}

describe("search over agents and skills", () => {
  it("is granted the reads it lists", () => {
    const permissions = new Set(READER);
    expect(operationIdGranted("listAgents", permissions, undefined)).toBe(true);
    expect(operationIdGranted("listSkills", permissions, undefined)).toBe(true);
  });

  it("searches every declared kind when none is named, one section each", async () => {
    const { call } = makeTools(READER);
    const result = await call("search", {});
    expect(Object.keys(result).sort()).toEqual(["agents", "operations", "skills"]);
    expect(result.agents).toEqual({
      total: 2,
      items: [
        {
          id: "@acme/invoice-sorter",
          title: "Invoice sorter",
          description: "Sorts invoices.",
          published: true,
        },
        // No display name: the id stands in.
        {
          id: "@acme/draft-only",
          title: "@acme/draft-only",
          description: "Not yet published.",
          published: false,
        },
      ],
    });
    // The skills of the space the call entered, not of every space the reader reaches.
    expect(result.skills).toEqual({
      total: 1,
      items: [
        {
          id: TONE.uri,
          package_id: "@acme/tone",
          name: "tone",
          description: "Sets the tone of a reply.",
        },
      ],
    });
    // Without keywords nothing is described.
    expect(result.best_match).toBeUndefined();
  });

  it("searches only the kinds named, and refuses a kind it does not declare", async () => {
    const { call, requests } = makeTools(READER);
    const skills = await call("search", { kinds: ["skill"], query: "tone" });
    expect(Object.keys(skills).sort()).toEqual(["best_match", "skills"]);
    expect(requests).toEqual([]);
    const refused = await call("search", { kinds: ["agent", "file"] });
    expect(refused).toMatchObject({ code: "invalid_argument", arguments: ["kinds"] });
    expect(refused.accepted).toEqual(["operation", "agent", "skill"]);
  });

  it("describes the best hit across kinds as best_match", async () => {
    const { call } = makeTools(READER);
    const agent = await call("search", { query: "@acme/invoice-sorter" });
    expect(agent.best_match).toMatchObject({
      kind: "agent",
      id: "@acme/invoice-sorter",
      version: "1.2.0",
      run_with: {
        tool: "run_and_wait",
        arguments: { kind: "agent", scope: "@acme", name: "invoice-sorter" },
      },
    });
    const skill = await call("search", { query: "tone" });
    expect(skill.best_match).toMatchObject({
      kind: "skill",
      id: TONE.uri,
      package_id: "@acme/tone",
    });
    const operation = await call("search", { query: "listAgents" });
    expect(operation.best_match).toMatchObject({ kind: "operation", id: "listAgents" });
  });

  it("relays the agents route's refusal in its section", async () => {
    const { byName, call } = makeTools(READER, 403);
    const named = await byName.get("search")!.handler({ kinds: ["agent"] }, noExtra);
    expect(named.isError).toBe(true);
    expect(parseResult(named)).toEqual({ status: 403, body: { code: "forbidden" } });
    // A search that did not name the kind leaves it out, and answers the rest.
    const defaulted = await call("search", {});
    expect(Object.keys(defaulted).sort()).toEqual(["operations", "skills"]);
  });

  it("narrows an omitted kinds to the kind of the filter passed, and refuses a filter its kinds exclude", async () => {
    const { call, requests } = makeTools(READER);
    const tagged = await call("search", { tag: "agents" });
    expect(Object.keys(tagged)).toEqual(["operations"]);
    expect(requests).toEqual([]);
    expect(await call("search", { kinds: ["agent"], tag: "agents" })).toMatchObject({
      code: "invalid_argument",
      arguments: ["tag"],
    });
  });

  it("names an acting tool only to a caller it is declared to", async () => {
    const reader = makeTools(["mcp:read", "agents:read", "skills:read"]);
    const description = reader.byName.get("search")!.descriptor.description!;
    expect(description).toContain("skills → read");
    expect(description).not.toContain("invoke_operation");
    expect(description).not.toContain("run_and_wait");
    const agent = await reader.call("describe", { kind: "agent", id: "@acme/invoice-sorter" });
    expect(agent.run_with).toBeUndefined();
  });

  it("declares agents and skills only to a caller granted their reads", async () => {
    const { byName, call } = makeTools(["mcp:read"]);
    const kinds = (
      byName.get("search")!.descriptor.inputSchema.properties as Record<
        string,
        { items: { enum: string[] } }
      >
    ).kinds!.items.enum;
    expect(kinds).toEqual(["operation"]);
    expect(Object.keys(await call("search", {}))).toEqual(["operations"]);
    expect(await call("describe", { kind: "agent", id: "@acme/invoice-sorter" })).toMatchObject({
      code: "invalid_argument",
      arguments: ["kind"],
      accepted: ["operation"],
    });
  });
});

describe("describe of an agent or a skill", () => {
  it("returns an agent's launch contract, without its editor state", async () => {
    const { call, requests } = makeTools(READER);
    const agent = await call("describe", { kind: "agent", id: "@acme/invoice-sorter" });
    // The definition a launch with `version` omitted runs.
    expect(requests).toEqual(["/api/packages/agents/@acme/invoice-sorter?version=latest"]);
    expect(agent.run_with).toEqual({
      tool: "run_and_wait",
      arguments: { kind: "agent", scope: "@acme", name: "invoice-sorter" },
    });
    expect(agent).toMatchObject({
      kind: "agent",
      id: "@acme/invoice-sorter",
      definition: "published",
      input: { schema: { type: "object", properties: { month: { type: "string" } } } },
    });
    expect(agent.prompt).toBeUndefined();
  });

  it("relays the agent route's refusal, and refuses an id that is not an agent's", async () => {
    const { byName, call } = makeTools(READER);
    const missing = await byName
      .get("describe")!
      .handler({ kind: "agent", id: "@acme/nope" }, noExtra);
    expect(missing.isError).toBe(true);
    expect(parseResult(missing)).toMatchObject({ status: 404, body: { code: "agent_not_found" } });
    expect(await call("describe", { kind: "agent", id: "nope" })).toMatchObject({
      code: "invalid_argument",
      arguments: ["id"],
    });
  });

  it("returns a skill's entry, and not_found for a URI the reader does not serve", async () => {
    const { call } = makeTools(READER);
    expect(await call("describe", { kind: "skill", id: TONE.uri })).toEqual({
      kind: "skill",
      id: TONE.uri,
      package_id: "@acme/tone",
      frontmatter: TONE.frontmatter,
      resources: TONE.resources,
      read_with: { tool: "read", arguments: { uri: TONE.uri } },
    });
    expect(
      await call("describe", { kind: "skill", id: "skill://spc_1/acme/gone/gone/SKILL.md" }),
    ).toMatchObject({ code: "not_found", arguments: ["id"] });
  });

  it("reads a skill only in the space the call entered", async () => {
    const { call } = makeTools(READER);
    // The reader answers for the other space too: the refusal is the call's own.
    expect(await call("describe", { kind: "skill", id: ELSEWHERE.uri })).toMatchObject({
      code: "space_mismatch",
      arguments: ["id"],
    });
    expect(await call("read", { uri: ELSEWHERE.uri })).toMatchObject({
      code: "space_mismatch",
      arguments: ["uri"],
    });
  });

  it("names what is missing", async () => {
    const { call } = makeTools(READER);
    expect(await call("describe", {})).toMatchObject({
      code: "missing_argument",
      arguments: ["kind", "id"],
    });
  });
});

describe("search across spaces", () => {
  const runWith = (result: Record<string, unknown>) =>
    (result.best_match as { run_with: { arguments: Record<string, unknown> } }).run_with.arguments;

  it("names no space in a best match's run_with unless the call named one", async () => {
    const { call } = makeTools(READER, 200, [], true);
    const across = await call("search", { query: "@acme/invoice-sorter", kinds: ["agent"] });
    expect(runWith(across)).toEqual({ kind: "agent", scope: "@acme", name: "invoice-sorter" });
    const named = await call("search", {
      query: "@acme/invoice-sorter",
      kinds: ["agent"],
      space_id: SPACE,
    });
    expect(runWith(named)).toMatchObject({ space_id: SPACE });
    const described = await call("describe", {
      kind: "agent",
      id: "@acme/invoice-sorter",
      space_id: SPACE,
    });
    expect((described.run_with as { arguments: object }).arguments).toMatchObject({
      space_id: SPACE,
    });
  });

  it("reports a space whose agents route refused, and answers the others", async () => {
    const { call } = makeTools(READER, 200, ["spc_2"], true);
    const result = await call("search", { kinds: ["agent"] });
    const agents = result.agents as { items: Array<{ granted_in: string[] }>; unsearched: unknown };
    expect(agents.items.every((item) => item.granted_in.join() === SPACE)).toBe(true);
    expect(agents.unsearched).toEqual([{ space_id: "spc_2", status: 403, code: "forbidden" }]);
  });
});
