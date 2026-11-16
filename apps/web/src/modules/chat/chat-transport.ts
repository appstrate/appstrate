// SPDX-License-Identifier: Apache-2.0

/** Pure pieces of the chat's host wiring (no React): its transport and where a picked conversation opens. */

import type { ChatScope, ChatTransport } from "@appstrate/module-chat/ui";
import { fetchOrThrow } from "../../api/client";

/**
 * The chat's `ChatTransport` over `getHeaders`: its REST calls go through {@link fetchOrThrow}, so
 * a refusal carries the server's code and reaches the shell's global error handling. An org route
 * (`/api/orgs/…`, the organization's chat) names no space and refuses `X-Space-Id`, so it carries
 * none; every other call keeps the working space's headers.
 */
export function chatTransport(
  getHeaders: () => Record<string, string>,
  scope: ChatScope,
): ChatTransport {
  return {
    getHeaders,
    scope,
    request: (path: string, init?: RequestInit) => {
      const headers = new Headers(getHeaders());
      if (path.startsWith("/api/orgs/")) headers.delete("X-Space-Id");
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      return fetchOrThrow(path, { ...init, headers });
    },
  };
}

/**
 * Where a conversation picked in the list opens. In « Vue d'ensemble » the list holds the sessions
 * of every space: a space session opens in its own space (the mode is left), an organization
 * session (`spaceId` null) and any pick in a space open in place.
 */
export function conversationOpening(
  scope: ChatScope,
  id: string | null,
  spaceId: string | null | undefined,
): { kind: "here" } | { kind: "in-space"; spaceId: string } {
  return id && spaceId && scope.kind === "organization"
    ? { kind: "in-space", spaceId }
    : { kind: "here" };
}
