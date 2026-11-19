// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { FILE_CONTENT_GRANT, type FileAccess } from "../services/files.ts";
import { issuingChatSessionId } from "./actor.ts";
import { callerPermissions, ceilingAllows } from "./permissions.ts";
import { callerReachableSpaces } from "./reachable-spaces.ts";
import { personaFor } from "./view-as.ts";

/**
 * The {@link FileAccess} of a request (run inputs, the MCP file tools, the REST doors by id and the
 * lists): its set in each space it reaches (`callerReachableSpaces`), and the issuing chat conversation, never
 * under a role preview, and only when the ceiling admits `files:read` (the bearer of a limited
 * turn holds no grant where its uploads live). A space the request entered keeps the request's own
 * set: an end-user has no reach, and one impersonated through an API key reaches with its
 * creator's role.
 */
export async function requestFileAccess(c: Context<AppEnv>): Promise<FileAccess> {
  const orgId = c.get("orgId");
  const entered = c.get("space")?.id;
  const reach = await callerReachableSpaces(c, orgId);
  const conversationId =
    personaFor(c, orgId) || !ceilingAllows(c, FILE_CONTENT_GRANT) ? null : issuingChatSessionId(c);
  return {
    grants: [
      ...(entered ? [{ spaceId: entered, permissions: callerPermissions(c) }] : []),
      ...reach
        .filter((space) => space.id !== entered)
        .map((space) => ({ spaceId: space.id, permissions: space.permissions })),
    ],
    ...(conversationId ? { conversationId } : {}),
  };
}
