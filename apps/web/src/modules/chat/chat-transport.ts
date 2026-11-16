// SPDX-License-Identifier: Apache-2.0

/** Pure piece of the chat's host wiring (no React): its transport. */

import type { ChatTransport } from "@appstrate/module-chat/ui";
import { fetchOrThrow } from "../../api/client";
import { isOrgRoute } from "../../lib/scoping-headers";

/**
 * The chat's `ChatTransport` over `getHeaders`: its REST calls go through {@link fetchOrThrow}, so
 * a refusal carries the server's code and reaches the shell's global error handling. An org route
 * (`/api/orgs/…`, where every chat call goes) names no space and carries no `X-Space-Id`; every
 * other call keeps the working space's headers. `spaceId` is the space the chat is filtered to,
 * `null` in « Vue d'ensemble ».
 */
export function chatTransport(
  getHeaders: () => Record<string, string>,
  orgId: string,
  spaceId: string | null,
): ChatTransport {
  return {
    getHeaders,
    orgId,
    spaceId,
    request: (path: string, init?: RequestInit) => {
      const headers = new Headers(getHeaders());
      if (isOrgRoute(path)) headers.delete("X-Space-Id");
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      return fetchOrThrow(path, { ...init, headers });
    },
  };
}
