// SPDX-License-Identifier: Apache-2.0

/** Pure piece of the chat's host wiring (no React): its transport. */

import type { ChatTransport } from "@appstrate/module-chat/ui";
import { fetchOrThrow } from "../../api/client";

/**
 * The chat's `ChatTransport` over `getHeaders`: its REST calls go through {@link fetchOrThrow}, so
 * a refusal carries the server's code and reaches the shell's global error handling. The chat's
 * routes ignore `X-Space-Id`, so the headers go as `getHeaders` builds them. `spaceId` is the space
 * the chat is filtered to, `null` in « Vue d'ensemble ».
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
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      return fetchOrThrow(path, { ...init, headers });
    },
  };
}
