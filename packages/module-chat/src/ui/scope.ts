// SPDX-License-Identifier: Apache-2.0

/**
 * What a `ChatScope` decides for every chat call: the route base, the headers, the cache key.
 * One place, so a space session and an organization session never share a route or a cache
 * entry. Calls that are not the chat's own (integrations, uploads, run reads) keep the host's
 * working-space headers: the overview keeps a working space.
 */

import type { ChatScope, ChatTransport } from "./runtime-context.ts";

/** The routes of the chat session API for `scope`. */
export function chatBase(scope: ChatScope): string {
  return scope.kind === "organization" ? `/api/orgs/${scope.orgId}/chat` : "/api/chat";
}

/** The chat route `suffix` (`/sessions`, `/enforced-skills`, `` for the turn) of the transport's scope. */
export function chatPath(transport: Pick<ChatTransport, "scope">, suffix = ""): string {
  return `${chatBase(transport.scope)}${suffix}`;
}

/**
 * The headers of a chat call: the host's, minus `X-Space-Id` in an organization scope (its routes
 * refuse it).
 */
export function chatHeaders(transport: Pick<ChatTransport, "getHeaders" | "scope">) {
  const headers = { ...transport.getHeaders() };
  if (transport.scope.kind === "organization") delete headers["X-Space-Id"];
  return headers;
}

/**
 * What every chat query is keyed by: the space (a key without it would serve another space's
 * list from cache), or the organization. `null` while the host's space store has not resolved.
 */
export function chatScopeKey(
  transport: Pick<ChatTransport, "getHeaders" | "scope"> | null | undefined,
): string | null {
  if (!transport) return null;
  if (transport.scope.kind === "organization") return `org:${transport.scope.orgId}`;
  return transport.getHeaders()["X-Space-Id"] ?? null;
}
