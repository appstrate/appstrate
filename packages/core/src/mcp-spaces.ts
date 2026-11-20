// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces of an organization-wide MCP connection, as the model reads them: one line per
 * space, and the refusal of a `space_id` argument that is missing or names none of them.
 * Shared by the MCP server and the chat's local tools, so the wording is the same on both.
 */

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
