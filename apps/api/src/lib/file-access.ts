// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { FILE_CONTENT_GRANT, type FileAccess } from "../services/files.ts";
import { issuingChatSessionId } from "./actor.ts";
import { callerPermissions, ceilingAllows } from "./permissions.ts";
import { callerReachableSpaces, type ReachableSpace } from "./reachable-spaces.ts";

/**
 * How this request reaches files across spaces, for `resolveFileAcrossSpaces`: the request's
 * own set in `enteredSpaceId`, its reach elsewhere (a credential bound to one space reaches no
 * other), and the files of the chat conversation that issued it, through their container and
 * capped by the credential's ceiling. Every door taking a file by id for a request builds it here.
 */
export function requestFileAccess(c: Context<AppEnv>, enteredSpaceId: string): FileAccess {
  let reach: Promise<ReachableSpace[]> | undefined;
  const conversation = issuingChatSessionId(c);
  return {
    grantIn: async (spaceId) =>
      spaceId === enteredSpaceId
        ? callerPermissions(c)
        : (await (reach ??= callerReachableSpaces(c, c.get("orgId")))).find(
            (space) => space.id === spaceId,
          )?.permissions,
    ...(conversation
      ? {
          conversation: {
            id: conversation,
            grantIn: () =>
              ceilingAllows(c, FILE_CONTENT_GRANT) ? new Set([FILE_CONTENT_GRANT]) : undefined,
          },
        }
      : {}),
  };
}
