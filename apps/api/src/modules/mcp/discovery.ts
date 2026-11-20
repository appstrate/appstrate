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
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
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
export interface RouteRefusal {
  status: number;
  body: unknown;
}

/** Spaces read at once by a search across spaces. */
const SPACES_AT_ONCE = 4;

/**
 * `read` in each of `spaces` (concurrently, bounded), the answers apart from the spaces whose
 * route refused. `undefined` stands for the one space a pinned connection is in.
 */
export async function readSpaces<S, T extends object>(
  spaces: readonly S[],
  read: (space: S) => Promise<T | { refused: RouteRefusal }>,
): Promise<{ answered: { space: S; value: T }[]; refused: { space: S; refused: RouteRefusal }[] }> {
  const reads = await mapWithConcurrency(spaces, SPACES_AT_ONCE, async (space) => ({
    space,
    value: await read(space),
  }));
  const answered: { space: S; value: T }[] = [];
  const refused: { space: S; refused: RouteRefusal }[] = [];
  for (const { space, value } of reads) {
    if ("refused" in value) refused.push({ space, refused: value.refused as RouteRefusal });
    else answered.push({ space, value: value as T });
  }
  return { answered, refused };
}

/** A space of a search across spaces whose read was refused, so its items are absent. */
interface UnsearchedSpace {
  space_id: string;
  status: number;
  code?: string;
}

/** The `unsearched` field of a section: the spaces (none for a pinned connection) whose read was refused. */
export function unsearched(
  refused: readonly { spaceId: string | undefined; refused: RouteRefusal }[],
): { unsearched?: UnsearchedSpace[] } {
  const spaces = refused.flatMap(({ spaceId, refused: route }): UnsearchedSpace[] => {
    if (!spaceId) return [];
    const code = asRecord(route.body)?.code;
    return [
      { space_id: spaceId, status: route.status, ...(typeof code === "string" ? { code } : {}) },
    ];
  });
  return spaces.length > 0 ? { unsearched: spaces } : {};
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
  options: { spaceId?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const headers = dispatchHeaders(ctx.authHeaders);
  if (options.spaceId) headers.set("x-space-id", options.spaceId);
  return ctx.dispatch(
    new Request(new URL(path, ctx.origin).toString(), {
      method: "GET",
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  );
}

/** The agents index of a space (`GET /api/agents`), the one reader of its rows. */
export async function listAgents(
  ctx: DispatchContext,
  options: { spaceId?: string; signal?: AbortSignal } = {},
): Promise<{ agents: AgentHit[] } | { refused: RouteRefusal }> {
  const response = await dispatchGet(ctx, "/api/agents", options);
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
  /** The space of its URI: where it is read. */
  granted_in: [string];
}

/** The published skills of `spaceIds`, as `skills/list` lists them. */
export async function listSkills(
  reader: McpSkillReader,
  spaceIds: readonly string[],
): Promise<SkillHit[]> {
  const entries = await reader.list();
  return entries.flatMap((entry): SkillHit[] => {
    const address = parseSkillUri(entry.uri);
    if (!address || !spaceIds.includes(address.spaceId)) return [];
    return [
      {
        id: entry.uri,
        package_id: address.packageId,
        name: entry.frontmatter.name,
        description: entry.frontmatter.description,
        granted_in: [address.spaceId],
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
  /** The `space_id` `read_with` names, org-wide: the space the call named. */
  readSpaceId?: string,
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
      read_with: {
        tool: KIND_USE.skill.tool,
        arguments: { uri: entry.uri, ...(readSpaceId ? { space_id: readSpaceId } : {}) },
      },
    },
  };
}
