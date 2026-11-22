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

import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { parseSkillUri } from "@appstrate/core/skill-uri";
import { ApiError } from "../../lib/errors.ts";
import type { DispatchContext } from "./api-call-batch.ts";
import type { SkillServer } from "./skills.ts";
import { spaceMismatchRefusal } from "./spaces.ts";
import { asRecord, dispatchHeaders, type Refusal, type RouteRefusal } from "./tool-results.ts";

/** The skills the connection reaches, as the Skills extension serves them. */
export type McpSkillReader = Pick<SkillServer, "list" | "entry" | "read">;

/** Spaces read at once by a search across spaces. */
const SPACES_AT_ONCE = 4;

interface SpaceReads<S, T> {
  answered: { space: S; value: T }[];
  refused: { space: S; refused: RouteRefusal }[];
}

const isRefused = (value: object): value is { refused: RouteRefusal } => "refused" in value;

/**
 * `read` in each of `spaces` (concurrently, bounded), the answers apart from the spaces whose
 * route refused. Without `spaces` (a pinned connection), one read in the space it is in.
 */
export function readSpaces<S, T extends object>(
  spaces: readonly S[],
  read: (space: S) => Promise<T | { refused: RouteRefusal }>,
): Promise<SpaceReads<S, T>>;
export function readSpaces<S, T extends object>(
  spaces: readonly S[] | undefined,
  read: (space: S | undefined) => Promise<T | { refused: RouteRefusal }>,
): Promise<SpaceReads<S | undefined, T>>;
export async function readSpaces<S, T extends object>(
  spaces: readonly S[] | undefined,
  read: (space: S | undefined) => Promise<T | { refused: RouteRefusal }>,
): Promise<SpaceReads<S | undefined, T>> {
  const reads = await mapWithConcurrency(spaces ?? [undefined], SPACES_AT_ONCE, async (space) => ({
    space,
    value: await read(space),
  }));
  const answered: SpaceReads<S | undefined, T>["answered"] = [];
  const refused: SpaceReads<S | undefined, T>["refused"] = [];
  for (const { space, value } of reads) {
    if (isRefused(value)) refused.push({ space, refused: value.refused });
    else answered.push({ space, value });
  }
  return { answered, refused };
}

/** The `unsearched` field of a section: the spaces (none for a pinned connection) whose read was refused. */
export function unsearched(
  refused: readonly { space: { id: string } | undefined; refused: RouteRefusal }[],
): { unsearched?: { space_id: string; status: number; code?: string }[] } {
  const spaces = refused.flatMap(({ space, refused: route }) => {
    if (!space) return [];
    const code = asRecord(route.body)?.code;
    return [
      { space_id: space.id, status: route.status, ...(typeof code === "string" ? { code } : {}) },
    ];
  });
  return spaces.length > 0 ? { unsearched: spaces } : {};
}

/**
 * The `searched` of a section: the spaces named by the `granted_in` of an entry shown. A space
 * that answered nothing shown contributed nothing to the result.
 */
export function spacesShown(...lists: readonly (readonly { granted_in?: readonly string[] }[])[]) {
  return [...new Set(lists.flat().flatMap((entry) => entry.granted_in ?? []))];
}

export interface AgentHit {
  id: string;
  display_name: string;
  description: string;
  published: boolean;
  /** The agent's chosen icon (`@appstrate/core/appearance` grammar), `null` when none. */
  icon: string | null;
  color: string | null;
}

/** A GET dispatched in-process, in the space `ctx` enters. */
export function dispatchGet(
  ctx: DispatchContext,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  return ctx.dispatch(
    new Request(new URL(path, ctx.origin).toString(), {
      method: "GET",
      headers: dispatchHeaders(ctx.authHeaders),
      ...(signal ? { signal } : {}),
    }),
  );
}

/** The agents index of a space (`GET /api/agents`), the one reader of its rows. */
export async function listAgents(
  ctx: DispatchContext,
  signal?: AbortSignal,
): Promise<{ agents: AgentHit[] } | { refused: RouteRefusal }> {
  const response = await dispatchGet(ctx, "/api/agents", signal);
  const body = asRecord(await response.json().catch(() => undefined));
  if (!response.ok || !Array.isArray(body?.data)) {
    return { refused: { status: response.status, body: body ?? null } };
  }
  const agents = body.data.flatMap((raw): AgentHit[] => {
    const row = asRecord(raw);
    const id = row?.id;
    if (typeof id !== "string" || parseScopedName(id) === null) return [];
    const name = typeof row?.display_name === "string" ? row.display_name.trim() : "";
    return [
      {
        id,
        display_name: name || id,
        description: typeof row?.description === "string" ? row.description : "",
        published: row?.published === true,
        icon: typeof row?.icon === "string" ? row.icon : null,
        color: typeof row?.color === "string" ? row.color : null,
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
  // An agent not active in the space cannot be launched there.
  if (launch && body.active !== false)
    agent.run_with = {
      tool: "run_and_wait",
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
  packageId: string;
  name: string;
  description: string;
  /** The space of its URI: where it is read. */
  granted_in: [string];
}

/**
 * The published skills of one space, as `skills/list` lists them; the refusal of a space whose
 * served skills cannot be read (an archive unavailable) instead of a failure of the call.
 */
export async function listSkills(
  reader: McpSkillReader,
  spaceId: string,
  requestId: string,
): Promise<{ skills: SkillHit[] } | { refused: RouteRefusal }> {
  let entries: Awaited<ReturnType<McpSkillReader["list"]>>;
  try {
    entries = await reader.list("published", [spaceId]);
  } catch (err) {
    if (err instanceof ApiError) {
      return { refused: { status: err.status, body: err.toProblemDetail(requestId) } };
    }
    throw err;
  }
  const skills = entries.flatMap((entry): SkillHit[] => {
    const address = parseSkillUri(entry.uri);
    if (!address) return [];
    return [
      {
        id: entry.uri,
        packageId: address.packageId,
        name: entry.frontmatter.name,
        description: entry.frontmatter.description,
        granted_in: [address.spaceId],
      },
    ];
  });
  return { skills };
}

/** The refusal of a skill URI in another space than the one the call entered, or `undefined`. */
export function skillSpaceRefusal(
  uri: string,
  spaceId: string,
  argument: string,
): Refusal | undefined {
  const address = parseSkillUri(uri);
  return address && address.spaceId !== spaceId
    ? spaceMismatchRefusal(`space ${spaceId}`, argument)
    : undefined;
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
      packageId: address.packageId,
      frontmatter: entry.frontmatter,
      resources: entry.resources,
    },
  };
}
