// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces of an organization-wide MCP connection, as the model reads them: one line per
 * space, and the refusal of a `space_id` argument that is missing or names none of them.
 * Shared by the MCP server and the chat's local tools, so the wording is the same on both.
 */

import { asRecord } from "./safe-json.ts";

/** Actual operation spaces, stamped by the platform for its chat client. */
export const OPERATION_SPACES_META_KEY = "dev.appstrate/operation-space-ids";

/** First-party result metadata: the spaces whose activation state the result disclosed. */
export const ACTIVE_SPACES_META_KEY = "dev.appstrate/active-space-ids";

/** Optional final clause of an activation refusal, present while a listed space can be used. */
export const ACTIVE_IN_SPACES_HINT = ", or use it in one of active_in_spaces.";

/** Restrict a launch problem's alternatives to spaces where this tool can repeat the call. */
export function projectActiveInSpaces(problem: unknown, eligible: () => readonly { id: string }[]) {
  const body = asRecord(problem);
  if (
    !("active_in_spaces" in body) ||
    (body.code !== "agent_not_active_in_space" &&
      body.code !== "package_not_active_in_space" &&
      body.code !== "inline_run_not_allowed_in_space" &&
      body.code !== "missing_integration_connection")
  )
    return undefined;
  const allowed = new Set(eligible().map((space) => space.id));
  const spaces = (Array.isArray(body.active_in_spaces) ? body.active_in_spaces : []).flatMap(
    (entry: unknown) => {
      const { id, name } = asRecord(entry);
      return typeof id === "string" && typeof name === "string" && allowed.has(id)
        ? [{ id, name }]
        : [];
    },
  );
  return {
    body: {
      ...body,
      ...(spaces.length === 0 &&
      typeof body.detail === "string" &&
      body.detail.endsWith(ACTIVE_IN_SPACES_HINT)
        ? { detail: body.detail.slice(0, -ACTIVE_IN_SPACES_HINT.length) + "." }
        : {}),
      active_in_spaces: spaces,
    },
    ids: spaces.map(({ id }) => id),
  };
}

/** A space an organization-wide MCP connection may act in. */
export interface NamedSpace {
  id: string;
  name: string;
  /** The caller's role there, as `GET /api/spaces` names it. */
  role: string;
  /** Whether it is the caller's own personal space. */
  personal?: boolean;
}

/** One line per space, for refusals and instructions. */
export function describeSpace(space: NamedSpace): string {
  const personal = space.personal ? ", your personal space" : "";
  return `${space.name} (\`${space.id}\`, role ${space.role}${personal})`;
}

/** What a caller may do in one space, in reading order: `get_me`'s `spaces[].can` and the chat's. */
const SPACE_ACTS = [
  "invoke_operations",
  "run_agents",
  "inline_runs",
  "call_integration_tools",
  "create_packages",
] as const;

export type SpaceAct = (typeof SPACE_ACTS)[number];

/** The acts `held` grants, in {@link SPACE_ACTS} order; an act left out is refused there. */
export function spaceActs(held: Readonly<Record<SpaceAct, boolean>>): SpaceAct[] {
  return SPACE_ACTS.filter((act) => held[act]);
}

/** The refusal of a `space_id` argument that is missing or names no reachable space. */
interface SpaceIdRefusal {
  code: "missing_argument" | "unknown_space";
  error: string;
  arguments: readonly ["space_id"];
  /** The ids the argument accepts. */
  accepted: readonly string[];
}

/**
 * The refusal a call's `space_id` earns on an organization-wide connection, or
 * undefined when it names one of `spaces`.
 */
export function spaceIdRefusal(
  spaces: readonly NamedSpace[],
  spaceId: unknown,
): SpaceIdRefusal | undefined {
  const accepted = spaces.map((space) => space.id);
  const list = spaces.map(describeSpace).join("; ");
  if (spaceId === undefined || spaceId === null) {
    return {
      code: "missing_argument",
      error: `space_id is required. Spaces you can act in: ${list}.`,
      arguments: ["space_id"],
      accepted,
    };
  }
  if (typeof spaceId !== "string" || !accepted.includes(spaceId)) {
    return {
      code: "unknown_space",
      error: `Unknown space_id: ${String(spaceId)}. Spaces you can act in: ${list}.`,
      arguments: ["space_id"],
      accepted,
    };
  }
  return undefined;
}

/** A destination already designated by the connection or the turn, in the platform's order. */
export function defaultMcpSpaceId(
  spaces: readonly NamedSpace[],
  originSpaceId: string | undefined,
  personalFirst: boolean,
): string | undefined {
  if (spaces.length === 1) return spaces[0]!.id;
  if (personalFirst) {
    const personal = spaces.find((space) => space.personal);
    if (personal) return personal.id;
  }
  return originSpaceId;
}
