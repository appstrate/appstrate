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

/**
 * `transport` for one LISTED session. The organization's list holds both kinds and each is
 * written through its own mount: an organization session through the organization's (the
 * transport as is), a space session through `/api/chat/*` entered in its own space, which the
 * organization's mount does not serve (404). One place, so every per-session call from a list row
 * takes the same route.
 */
export function transportForSession(
  transport: ChatTransport,
  session: { spaceId: string | null },
): ChatTransport {
  const { spaceId } = session;
  if (transport.scope.kind !== "organization" || spaceId === null) return transport;
  return {
    ...transport,
    scope: { kind: "space" },
    request: (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("X-Space-Id", spaceId);
      return transport.request(path, { ...init, headers });
    },
  };
}
