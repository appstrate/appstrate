// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { FILE_CONTENT_GRANT, type FileAccess } from "../services/files.ts";
import { issuingChatSessionId } from "./actor.ts";
import { callerPermissions, ceilingAllows } from "./permissions.ts";
import { callerReachableSpaces, type ReachableSpace } from "./reachable-spaces.ts";
import { personaFor } from "./view-as.ts";

/**
 * The {@link FileAccess} of a request (run inputs, the MCP file tools): its set in the space it
 * entered, its reach elsewhere, and the issuing chat conversation — none under a role preview,
 * whose reach has no personal space either. Its uploads need `files:read` in the ceiling: the
 * owner holds it in their personal space, which the turn's bearer may not reach.
 */
export function requestFileAccess(c: Context<AppEnv>, enteredSpaceId: string): FileAccess {
  let reach: Promise<ReachableSpace[]> | undefined;
  const orgId = c.get("orgId");
  const conversation = personaFor(c, orgId) ? null : issuingChatSessionId(c);
  const ownUploads = ceilingAllows(c, FILE_CONTENT_GRANT)
    ? new Set([FILE_CONTENT_GRANT])
    : undefined;
  return {
    grantIn: async (spaceId) =>
      spaceId === enteredSpaceId
        ? callerPermissions(c)
        : (await (reach ??= callerReachableSpaces(c, orgId))).find((space) => space.id === spaceId)
            ?.permissions,
    ...(conversation
      ? { conversation: { id: conversation, grantIn: async () => ownUploads } }
      : {}),
  };
}
