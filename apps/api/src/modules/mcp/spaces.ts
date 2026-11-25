// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces an MCP connection acts in: pinned (credential or URL) or org-wide,
 * one space entered per HTTP request. Design: `docs/plans/mcp-org-wide-spaces.md`.
 */

import type { Context } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { notFound } from "../../lib/errors.ts";
import { loadFileForPreview } from "../../services/files.ts";
import { parseFileUri } from "@appstrate/core/file-uri";
import { enterableSpaces, type ReachableSpace } from "../../lib/reachable-spaces.ts";
import { toSpaceRoleWire } from "../../lib/space-role.ts";
import type { DispatchPin } from "../../lib/internal-dispatch.ts";
import type { Dispatch, McpSurface } from "./tools.ts";
import { resolveCallSpace } from "./call-space.ts";
import { describeSpace, spaceIdRefusal } from "@appstrate/core/mcp-spaces";
import type { Refusal } from "./tool-results.ts";

/** A space this connection may act in, with the caller's permissions there. */
export interface McpSpace {
  id: string;
  name: string;
  /** The caller's role there, as `GET /api/spaces` names it. */
  role: string;
  /** Whether it is the caller's own personal space. */
  personal: boolean;
  permissions: ReadonlySet<string>;
  /** The acts the caller holds there (`deriveMcpSurface` over `permissions` and the space). */
  surface: McpSurface;
}

/** The spaces of an org-wide connection, and the one this request entered. */
export interface OrgWideSpaces {
  reachable: readonly McpSpace[];
  current: McpSpace;
  /** A credential bound to a set acts in one destination even on aggregate routes. */
  bounded?: boolean;
  ceiling?: ReadonlySet<string>;
  orgPermissions?: ReadonlySet<string>;
  originSpaceId?: string;
  spaceChoice?: { spaceId: string; tool: string; operationId?: string };
  beforeAct?: (spaceId: string) => Promise<void>;
}

/** An org-wide connection as a tool reads it. */
export interface OrgWideToolSpaces extends OrgWideSpaces {
  /** A dispatch run in one reachable space; throws for any other. */
  dispatchIn: (spaceId: string) => Dispatch;
}

/** Track spaces discovered after an operation authorizes its resource, before it acts there. */
export function recordOperationSpaces(
  spaces: OrgWideSpaces | undefined,
  already: readonly string[] = [],
) {
  const ids = new Set(already);
  const beforeAct = spaces?.beforeAct;
  const record = beforeAct
    ? async (spaceIds: readonly string[]) => {
        for (const id of spaceIds) {
          if (ids.has(id)) continue;
          if (!spaces.reachable.some((space) => space.id === id)) throw notFound("Space not found");
          await beforeAct(id);
          ids.add(id);
        }
        return true;
      }
    : undefined;
  return { ids, record };
}

/** {@link OrgWideToolSpaces.dispatchIn} over `send`: a `bound` credential is pinned to the space per dispatch, any other enters it by `x-space-id`. */
export function spaceDispatcher(
  spaces: OrgWideSpaces,
  send: (request: Request, pin?: DispatchPin) => Promise<Response>,
  bound: boolean,
): (spaceId: string) => Dispatch {
  return (spaceId) => {
    if (!spaces.reachable.some((space) => space.id === spaceId)) {
      throw new Error(`Space ${spaceId} is not one this connection reaches.`);
    }
    return (request) => {
      request.headers.set("x-space-id", spaceId);
      return send(request, bound ? { spaceId } : undefined);
    };
  };
}

/** The credential's space and the URL's (`/api/mcp/o/:org/s/:space`), when set. */
export function pinnedSpaceIds(c: Context<AppEnv>): string[] {
  return [c.get("spaceId"), c.req.param("space")].filter((id): id is string => Boolean(id));
}

/**
 * The reachable spaces whose role grants `mcp:read` (the MCP acts, it does not browse), each
 * with the acts `surfaceOf` gives it there.
 */
export async function listReachableSpaces(
  c: Context<AppEnv>,
  orgId: string,
  surfaceOf: (
    permissions: ReadonlySet<string>,
    space: Pick<ReachableSpace, "credentialProxyOpen">,
  ) => McpSurface,
): Promise<McpSpace[]> {
  return (await enterableSpaces(c, orgId))
    .filter((space) => space.permissions.has("mcp:read"))
    .map((space) => ({
      id: space.id,
      name: space.name,
      role: toSpaceRoleWire(space.role)!.name,
      personal: space.personal,
      permissions: space.permissions,
      surface: surfaceOf(space.permissions, space),
    }));
}

/**
 * The space the body's first message names: a `tools/call`'s `space_id`, or
 * the space of the file a `resources/read` of an `appfile://` URI reads.
 */
export async function requestedSpaceId(
  message: unknown,
  orgId: string,
  policy: Omit<OrgWideSpaces, "current">,
): Promise<string | undefined> {
  const first: unknown = Array.isArray(message) ? message[0] : message;
  if (typeof first !== "object" || first === null) return undefined;
  const { method, params } = first as { method?: unknown; params?: Record<string, unknown> };
  if (typeof params !== "object" || params === null) return undefined;
  let resourceUri = params.uri;
  if (method === "tools/call") {
    const args =
      typeof params.arguments === "object" && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
    const chosen = resolveCallSpace(params.name, args, policy);
    if (params.name !== "read" || chosen.kind !== "row")
      return chosen.kind !== "none" && typeof chosen.id === "string" ? chosen.id : undefined;
    resourceUri = args.uri;
  }
  if ((method === "resources/read" || method === "tools/call") && typeof resourceUri === "string") {
    const fileId = parseFileUri(resourceUri);
    return (fileId && (await loadFileForPreview(orgId, fileId))?.spaceId) || undefined;
  }
  return undefined;
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

/** The ids of the spaces where `granted` holds. */
export function spaceIdsWhere(
  spaces: readonly McpSpace[],
  granted: (space: McpSpace) => boolean,
): string[] {
  return spaces.filter(granted).map((space) => space.id);
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

/** The rule a refusal for the caller's role carries in org-wide mode. */
export const NO_FALLBACK_HINT =
  "Do not retry in another space on your own to get around the refusal: name a space of " +
  "`granted_in` or `active_in_spaces`, when there is one, and act there only once the user " +
  "chooses it.";

export function spaceMismatchRefusal(acts: string, argument: string, space?: McpSpace): Refusal {
  return {
    code: "space_mismatch",
    error: `This request acts in ${acts}; send a call for another space as its own request.`,
    arguments: [argument],
    ...(space ? { space: spaceRef(space) } : {}),
  };
}

/** The refusal a call's `space_id` earns, or undefined when it names the entered space. */
export function spaceArgumentRefusal(spaces: OrgWideSpaces, spaceId: unknown): Refusal | undefined {
  const named = spaceIdRefusal(spaces.reachable, spaceId);
  if (named) return named;
  return spaceId !== spaces.current.id
    ? spaceMismatchRefusal(describeSpace(spaces.current), "space_id", spaces.current)
    : undefined;
}
