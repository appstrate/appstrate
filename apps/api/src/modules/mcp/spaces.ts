// SPDX-License-Identifier: Apache-2.0

/**
 * Org-wide mode: one MCP connection reaches every space of the organization
 * where the caller holds a role (`docs/plans/mcp-org-wide-spaces.md`).
 *
 * A connection is PINNED when a strategy fixed its space (API key, end-user
 * token) or the request carries `X-Space-Id` — the chat does — and behaves as
 * it always did. Otherwise it is ORG-WIDE: the router lists the caller's
 * spaces once per request, and each tool call names the space it acts in with
 * a `space_id` argument.
 *
 * One HTTP request still enters exactly ONE space. The transport is stateless
 * and a `tools/call` request carries one call, so the router reads that call's
 * `space_id` before building the tools and enters the space through the same
 * door as the header (`enterSpaceById`). Everything downstream — the route
 * guards of dispatched calls, and the tools that call a service directly with
 * the request context (`read_skill`, files, package import) — then reads the
 * caller's role in that space and nothing else.
 */

import type { Context } from "hono";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AppEnv } from "../../types/index.ts";
import { listSpacesForPrincipal } from "../../services/spaces.ts";
import { fileSpaceId } from "../../services/files.ts";
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

/**
 * Pinned: a strategy fixed the space (API key, end-user token) or the client
 * sent `X-Space-Id`. Every other connection is org-wide.
 */
export function isPinnedConnection(c: Context<AppEnv>): boolean {
  return Boolean(c.get("spaceId") || c.req.header("X-Space-Id"));
}

/**
 * The spaces where the caller holds a role AND may use MCP (`mcp:read` is a
 * space-level grant). The same listing `GET /api/spaces` serves, persona
 * overlay included; spaces visible without a role are left out — the MCP acts,
 * it does not browse.
 */
export async function listReachableSpaces(
  c: Context<AppEnv>,
  orgId: string,
  surfaceOf: (permissions: ReadonlySet<string>) => McpSurface,
): Promise<McpSpace[]> {
  // Fails closed: a principal without an org role reaches no space this way.
  const orgRole = callerOrgRole(c, orgId);
  if (!orgRole) return [];
  const entries = await listSpacesForPrincipal(
    orgId,
    orgRole,
    c.get("user").id,
    callerPersonalOwnerId(c, orgId),
    personaMemberships(personaFor(c, orgId)),
  );
  const out: McpSpace[] = [];
  for (const { space, role } of entries) {
    if (!role) continue;
    const permissions = effectiveInSpace(c, role);
    if (!permissions.has("mcp:read")) continue;
    out.push({
      id: space.id,
      name: space.name,
      role: toSpaceRoleWire(role)!.name,
      permissions,
      surface: surfaceOf(permissions),
    });
  }
  return out;
}

/**
 * The space a JSON-RPC body names: a `tools/call`'s `space_id`, or, for a
 * `resources/read` of an `appfile://` URI, the space holding that file — a
 * file row belongs to one space, so the URI names it, and the `resource_link`
 * a run returns is read without any other argument. Only the first message of
 * a batch is read (MCP 2025-06-18 has no batches): a later `tools/call` naming
 * another space is refused by `assertSpaceArgument`, a later read of another
 * space's file answers "not found".
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
    return (fileId && (await fileSpaceId(orgId, fileId))) || undefined;
  }
  return undefined;
}

/** The space a request enters: the one named if reachable, else any reachable one (see the router). */
export function pickSpace(
  reachable: readonly McpSpace[],
  requested: string | undefined,
): McpSpace | undefined {
  return reachable.find((s) => s.id === requested) ?? reachable[0];
}

/** One line per space, for refusals and instructions. */
export function describeSpace(space: McpSpace): string {
  return `${space.name} (\`${space.id}\`, role ${space.role})`;
}

/**
 * `granted_in`: the spaces where `granted` holds, set only when they are not
 * all of them — absent means "every space you reach", the same rule as the
 * bracketed operation index. Absent too on a pinned connection (no `spaces`).
 */
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

/**
 * Validate a call's `space_id` against the space the request entered. It is
 * always required, whether the caller reaches one space or several: one
 * schema, no default. Missing or unknown → -32602 listing the reachable spaces.
 */
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
