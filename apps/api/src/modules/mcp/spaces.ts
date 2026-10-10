// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces an MCP connection acts in: pinned (credential or URL) or org-wide,
 * one space entered per HTTP request. Design: `docs/plans/mcp-org-wide-spaces.md`.
 */

import type { Context } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { listSpacesForPrincipal } from "../../services/spaces.ts";
import { loadFileForPreview } from "../../services/files.ts";
import { parseFileUri } from "@appstrate/core/file-uri";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  effectiveInSpace,
  personaFor,
  personaMemberships,
} from "../../lib/view-as.ts";
import { toSpaceRoleWire } from "../../lib/space-role.ts";
import type { McpSurface } from "./tools.ts";
import type { Refusal } from "./tool-results.ts";

/** A space this connection may act in, with the caller's permissions there. */
export interface McpSpace {
  id: string;
  name: string;
  /** The caller's role there, as `GET /api/spaces` names it. */
  role: string;
  permissions: ReadonlySet<string>;
  /** The acts the caller holds there (`deriveMcpSurface` over `permissions`). */
  surface: McpSurface;
}

/** The spaces of an org-wide connection, and the one this request entered. */
export interface OrgWideSpaces {
  reachable: readonly McpSpace[];
  current: McpSpace;
}

/** The credential's space and the URL's (`/api/mcp/o/:org/s/:space`), when set. */
export function pinnedSpaceIds(c: Context<AppEnv>): string[] {
  return [c.get("spaceId"), c.req.param("space")].filter((id): id is string => Boolean(id));
}

/** The spaces of `GET /api/spaces` where the caller holds a role granting `mcp:read`. */
export async function listReachableSpaces(
  c: Context<AppEnv>,
  orgId: string,
): Promise<Omit<McpSpace, "surface">[]> {
  const orgRole = callerOrgRole(c, orgId);
  if (!orgRole) return [];
  const entries = await listSpacesForPrincipal(
    orgId,
    orgRole,
    c.get("user").id,
    callerPersonalOwnerId(c, orgId),
    personaMemberships(personaFor(c, orgId)),
  );
  const out: Omit<McpSpace, "surface">[] = [];
  for (const { space, role } of entries) {
    if (!role) continue;
    const permissions = effectiveInSpace(c, role);
    if (!permissions.has("mcp:read")) continue;
    out.push({
      id: space.id,
      name: space.name,
      role: toSpaceRoleWire(role)!.name,
      permissions,
    });
  }
  return out;
}

/**
 * The space the body's first message names: a `tools/call`'s `space_id`, or
 * the space of the file a `resources/read` of an `appfile://` URI reads.
 */
export async function requestedSpaceId(
  message: unknown,
  orgId: string,
): Promise<string | undefined> {
  const first: unknown = Array.isArray(message) ? message[0] : message;
  if (typeof first !== "object" || first === null) return undefined;
  const { method, params } = first as { method?: unknown; params?: Record<string, unknown> };
  if (typeof params !== "object" || params === null) return undefined;
  if (method === "tools/call") {
    const args = params.arguments as { space_id?: unknown } | undefined;
    return typeof args?.space_id === "string" ? args.space_id : undefined;
  }
  if (method === "resources/read" && typeof params.uri === "string") {
    const fileId = parseFileUri(params.uri);
    return (fileId && (await loadFileForPreview(orgId, fileId))?.spaceId) || undefined;
  }
  return undefined;
}

/** One line per space, for refusals and instructions. */
export function describeSpace(space: McpSpace): string {
  return `${space.name} (\`${space.id}\`, role ${space.role})`;
}

/** The reachable spaces where `granted` holds; undefined when not org-wide or when all hold. */
export function grantedSpaces(
  spaces: OrgWideSpaces | undefined,
  granted: (space: McpSpace) => boolean,
): McpSpace[] | undefined {
  if (!spaces) return undefined;
  const matching = spaces.reachable.filter(granted);
  return matching.length === spaces.reachable.length ? undefined : matching;
}

/** `granted_in` by space ID. */
export function grantedIn(
  spaces: OrgWideSpaces | undefined,
  granted: (space: McpSpace) => boolean,
): { granted_in?: string[] } {
  const matching = grantedSpaces(spaces, granted);
  return matching ? { granted_in: matching.map((s) => s.id) } : {};
}

/** The space a result was produced in, by id and name. */
export function spaceRef(space: McpSpace): { id: string; name: string } {
  return { id: space.id, name: space.name };
}

/** The rule a refusal carries in org-wide mode. */
export const NO_FALLBACK_HINT =
  "Do not retry this action in another space to get around the refusal; report it to the " +
  "user, who decides which space the action belongs in.";

/** The refusal a call's `space_id` earns, or undefined when it names the entered space. */
export function spaceArgumentRefusal(spaces: OrgWideSpaces, spaceId: unknown): Refusal | undefined {
  const accepted = spaces.reachable.map((s) => s.id);
  const list = spaces.reachable.map(describeSpace).join("; ");
  if (spaceId === undefined) {
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
  if (spaceId !== spaces.current.id) {
    return {
      code: "space_mismatch",
      error:
        `This request acts in ${describeSpace(spaces.current)}; ` +
        "send a call for another space as its own request.",
      arguments: ["space_id"],
      space: spaceRef(spaces.current),
    };
  }
  return undefined;
}
