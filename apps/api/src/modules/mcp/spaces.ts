// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces an MCP connection acts in: pinned (credential or URL) or org-wide,
 * one space entered per HTTP request. Design: `docs/plans/mcp-org-wide-spaces.md`.
 */

import type { Context } from "hono";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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

/** `granted_in`: the spaces where `granted` holds, absent when it holds in all (or pinned). */
export function grantedIn(
  spaces: OrgWideSpaces | undefined,
  granted: (space: McpSpace) => boolean,
): { granted_in?: string[] } {
  if (!spaces) return {};
  const names = spaces.reachable.filter(granted).map((s) => s.name);
  return names.length === spaces.reachable.length ? {} : { granted_in: names };
}

/** The space a result was produced in, by id and name. */
export function spaceRef(space: McpSpace): { id: string; name: string } {
  return { id: space.id, name: space.name };
}

/** The rule a refusal carries in org-wide mode. */
export const NO_FALLBACK_HINT =
  "Do not retry this action in another space to get around the refusal; report it to the " +
  "user, who decides which space the action belongs in.";

/** A call's `space_id` must name the space the request entered; else -32602 listing them. */
export function assertSpaceArgument(spaces: OrgWideSpaces, spaceId: unknown): void {
  const list = spaces.reachable.map(describeSpace).join("; ");
  if (spaceId === undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `space_id is required. Spaces you can act in: ${list}.`,
    );
  }
  if (typeof spaceId !== "string" || !spaces.reachable.some((s) => s.id === spaceId)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unknown space_id: ${String(spaceId)}. Spaces you can act in: ${list}.`,
    );
  }
  if (spaceId !== spaces.current.id) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `This request acts in ${spaces.current.name}; send a call for another space as its own request.`,
    );
  }
}
