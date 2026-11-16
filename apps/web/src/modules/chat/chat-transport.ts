// SPDX-License-Identifier: Apache-2.0

/** Pure pieces of the chat's host wiring (no React): its transport and where a picked conversation opens. */

import type { ChatScope, ChatTransport } from "@appstrate/module-chat/ui";
import { fetchOrThrow } from "../../api/client";
import { isOrgRoute } from "../../lib/scoping-headers";

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
      if (isOrgRoute(path)) headers.delete("X-Space-Id");
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

/** What a chat page was last serving: its scope, and the conversation it showed. */
export interface ChatPlace {
  scopeId: string;
  conversationId: string | null;
}

/**
 * The identity of what the chat serves: the organization, or the working space. Two places of
 * different ids do not share conversations (a session belongs to the kind of scope that opened it).
 */
export function chatScopeId(scope: ChatScope, spaceId: string | null): string | null {
  if (scope.kind === "organization") return `org:${scope.orgId}`;
  return spaceId;
}

/**
 * Whether the page must drop to a new conversation: the scope changed (space ↔ organization, or
 * another space) while the conversation did not. The open conversation is the old scope's: read
 * through the new one it is a 404, a streaming turn is lost, and a conversation not yet saved
 * would post its first message to the old scope's route (its turn route is fixed when it is
 * created). A pick in the list changes both at once (it enters the session's own scope): the
 * router lags the address bar, so `liveConversationId`, the conversation the ADDRESS names now,
 * tells a navigation still in flight, which is left alone.
 */
export function scopeChangeLeavesConversation(
  previous: ChatPlace | null,
  next: ChatPlace,
  liveConversationId: string | null,
): boolean {
  return (
    previous !== null &&
    previous.scopeId !== next.scopeId &&
    previous.conversationId === next.conversationId &&
    liveConversationId === next.conversationId
  );
}

/** The conversation an address names (`/chat/:conversationId`), none for any other. */
export function conversationOfPath(pathname: string): string | null {
  return pathname.match(/^\/chat\/([^/]+)\/?$/)?.[1] ?? null;
}
