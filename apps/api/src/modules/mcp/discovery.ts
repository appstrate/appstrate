// SPDX-License-Identifier: Apache-2.0

/**
 * The agents and skills `search` lists and `describe` details, beside the operations of the
 * catalog (`tools.ts`) and the integration tools (`integration-tools.ts`).
 *
 * Agents are read by an in-process dispatch on the routes a REST client reads them from
 * (`GET /api/agents`, `GET /api/packages/agents/{scope}/{name}`), in the space the call entered,
 * so their guards decide. Skills are read through the Skills extension's reader (`skills.ts`),
 * the one `resources/read` and the `read` tool use, so a skill is listed exactly when it can be
 * read.
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { parseSkillUri, type SkillEntry } from "@appstrate/core/skill-uri";
import type { DispatchContext } from "./api-call-batch.ts";
import { asRecord, dispatchHeaders, type Refusal } from "./tool-results.ts";

/** The kinds of things `search` finds and `describe` details. */
export const DISCOVERY_KINDS = ["operation", "integration_tool", "agent", "skill"] as const;
export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number];

/**
 * The tool that acts on each kind, and the surface act that declares it (`null`: always
 * declared). A hint names the tool only to a caller it is declared to.
 */
export const KIND_USE: Record<
  DiscoveryKind,
  { tool: string; act: "invokes" | "proxies" | "runs" | null }
> = {
  operation: { tool: "invoke_operation", act: "invokes" },
  integration_tool: { tool: "call_integration_tool", act: "proxies" },
  agent: { tool: "run_and_wait", act: "runs" },
  skill: { tool: "read", act: null },
};

/** The skills the connection reaches, as the Skills extension serves them. */
export interface McpSkillReader {
  /** The published skills of every space reached. */
  list: () => Promise<SkillEntry[]>;
  /** The entry whose `SKILL.md` is at `uri`, `null` when none is readable there. */
  entry: (uri: string) => Promise<SkillEntry | null>;
  /** `resources/read` of a `skill://` URI; throws the extension's JSON-RPC error. */
  read: (uri: string) => Promise<ReadResourceResult>;
}

/** A route's refusal, as `invoke_operation` relays one: its status and problem body. */
interface RouteRefusal {
  status: number;
  body: unknown;
}

export interface AgentHit {
  id: string;
  title: string;
  description: string;
  published: boolean;
}

/** A GET dispatched in-process, in `spaceId` when given and in the space the caller's headers enter otherwise. */
export function dispatchGet(
  ctx: DispatchContext,
  path: string,
  spaceId?: string,
): Promise<Response> {
  const headers = dispatchHeaders(ctx.authHeaders);
  if (spaceId) headers.set("x-space-id", spaceId);
  return ctx.dispatch(
    new Request(new URL(path, ctx.origin).toString(), { method: "GET", headers }),
  );
}

/** The agents index of a space (`GET /api/agents`), the one reader of its rows. */
export async function listAgents(
  ctx: DispatchContext,
  spaceId?: string,
): Promise<{ agents: AgentHit[] } | { refused: RouteRefusal }> {
  const response = await dispatchGet(ctx, "/api/agents", spaceId);
  const body = asRecord(await response.json().catch(() => undefined));
  if (!response.ok || !Array.isArray(body?.data)) {
    return { refused: { status: response.status, body: body ?? null } };
  }
  const agents = body.data.flatMap((raw): AgentHit[] => {
    const row = asRecord(raw);
    const id = row?.id;
    if (typeof id !== "string" || parseScopedName(id) === null) return [];
    const title = typeof row?.display_name === "string" ? row.display_name.trim() : "";
    return [
      {
        id,
        title: title || id,
        description: typeof row?.description === "string" ? row.description : "",
        published: row?.published === true,
      },
    ];
  });
  return { agents };
}

/** Fields of the agent detail a launch needs; the rest is the agent's editor state. */
const AGENT_LAUNCH_FIELDS = [
  "display_name",
  "description",
  "version",
  "definition",
  "active",
  "home_writable",
  "input",
  "output",
  "effective_timeout_seconds",
  "dependencies",
] as const;

/**
 * An agent's launch contract, from its detail at the definition a launch by this caller runs
 * (`GET /api/packages/agents/{scope}/{name}?version=latest`, what a launch with `version` omitted runs): its input schema, stored
 * values and locked fields, its output, and the integrations it declares.
 */
export async function describeAgent(
  ctx: DispatchContext,
  id: string,
  /**
   * How a launch is named: `null` when the caller is not offered `run_and_wait`, else the space
   * it names org-wide (`run_and_wait` requires `space_id` there).
   */
  launch: { spaceId?: string } | null,
): Promise<{ agent: Record<string, unknown> } | { refused: RouteRefusal } | { refusal: Refusal }> {
  const scoped = parseScopedName(id);
  if (!scoped) {
    return {
      refusal: {
        code: "invalid_argument",
        error: `Not an agent id: ${id}. An agent is named \`@scope/name\`, as search returns it.`,
        arguments: ["id"],
      },
    };
  }
  const response = await dispatchGet(
    ctx,
    `/api/packages/agents/${encodePackageIdPath(id)}?version=latest`,
  );
  const body = asRecord(await response.json().catch(() => undefined));
  if (!response.ok || !body) {
    return { refused: { status: response.status, body: body ?? null } };
  }
  const agent: Record<string, unknown> = { id };
  for (const field of AGENT_LAUNCH_FIELDS) {
    if (body[field] !== undefined) agent[field] = body[field];
  }
  if (launch)
    agent.run_with = {
      tool: KIND_USE.agent.tool,
      arguments: {
        kind: "agent",
        scope: `@${scoped.scope}`,
        name: scoped.name,
        ...(launch.spaceId ? { space_id: launch.spaceId } : {}),
      },
    };
  return { agent };
}

export interface SkillHit {
  id: string;
  package_id: string;
  name: string;
  description: string;
}

/** The published skills of `spaceId`, as `skills/list` lists them. */
export async function listSkills(reader: McpSkillReader, spaceId: string): Promise<SkillHit[]> {
  const entries = await reader.list();
  return entries.flatMap((entry): SkillHit[] => {
    const address = parseSkillUri(entry.uri);
    if (!address || address.spaceId !== spaceId) return [];
    return [
      {
        id: entry.uri,
        package_id: address.packageId,
        name: entry.frontmatter.name,
        description: entry.frontmatter.description,
      },
    ];
  });
}

/**
 * The refusal of a skill URI in another space than the one the call entered (`spaceId`), or
 * `undefined`: a call reads only the space it names, which is the one the chat records.
 */
export function skillSpaceRefusal(
  uri: string,
  spaceId: string,
  argument: string,
): Refusal | undefined {
  const address = parseSkillUri(uri);
  if (!address || address.spaceId === spaceId) return undefined;
  return {
    code: "space_mismatch",
    error: `This call acts in space ${spaceId}; ${uri} is in another space. Send a call for that space as its own request.`,
    arguments: [argument],
  };
}

/** A skill's entry: its frontmatter and the `skill://` URI of each of its files. */
export async function describeSkill(
  reader: McpSkillReader,
  uri: string,
  spaceId: string,
): Promise<{ skill: Record<string, unknown> } | { refusal: Refusal }> {
  const mismatch = skillSpaceRefusal(uri, spaceId, "id");
  if (mismatch) return { refusal: mismatch };
  const address = parseSkillUri(uri);
  const entry = address ? await reader.entry(uri) : null;
  if (!address || !entry) {
    return {
      refusal: {
        code: "not_found",
        error: `No skill readable at ${uri}. Take a skill's id from search.`,
        arguments: ["id"],
      },
    };
  }
  return {
    skill: {
      id: entry.uri,
      package_id: address.packageId,
      frontmatter: entry.frontmatter,
      resources: entry.resources,
      read_with: { tool: KIND_USE.skill.tool, arguments: { uri: entry.uri } },
    },
  };
}
