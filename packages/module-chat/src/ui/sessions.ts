// SPDX-License-Identifier: Apache-2.0

/**
 * Thin REST helpers over the chat session API, sent through the host's `request`
 * (scoping headers added, RFC 9457 failures thrown as the host's error). The server
 * is the single writer of messages, so there is no client message-write helper —
 * only session list/CRUD + history load.
 */

import {
  queryOptions,
  skipToken,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { UIMessage } from "ai";
import type { TokenUsage } from "@appstrate/core/token-usage";
import type { SkillSettingsPatch, PinnedSkill } from "../skills.ts";
import type { StoredSkills } from "./chat-skills.ts";
import { errorStatus, jsonInit, type ChatTransport } from "./runtime-context.ts";
import { chatPath } from "./chat-route.ts";

/** Fresh session id, minted client-side (`chs_` shape) — re-exported from the shared module. */
export { mintSessionId } from "../session-id.ts";

export interface SessionSummary {
  id: string;
  title: string | null;
  /** True while a turn is generating — drives the poll cadence + unread badge. */
  generating: boolean;
  /** Server-computed: an assistant reply landed after the caller last read it. */
  unread: boolean;
  /** ISO timestamp of the last activity — surfaced as a relative time in the list. */
  updatedAt: string;
  /** The origin space: the one selected when the conversation was created, `null` from the overview. */
  spaceId: string | null;
  /** Limited to its origin space. Always false without one. */
  restricted: boolean;
  /** The spaces the conversation touched (origin first); empty when it touched none. */
  space_ids: string[];
}

/**
 * Prefix every chat-session-list key starts with (module-local, not the typed
 * client). Exported for the app shell, which invalidates on it — a prefix match,
 * so it still reaches the filtered keys below.
 */
export const SESSIONS_QUERY_KEY = ["chat", "sessions"] as const;

/**
 * The conversation list under ONE space filter (`null`: « Tous les espaces », every conversation).
 * The filter belongs in the key: a key without it would serve another filter's list from cache.
 */
export function sessionsQueryKey(spaceId: string | null): readonly unknown[] {
  return [...SESSIONS_QUERY_KEY, spaceId];
}

/**
 * The title-search results under one filter. Nested under `sessionsQueryKey` on
 * purpose: an invalidation (or `setQueriesData`) on the prefix reaches the
 * filtered lists too. The default list's key shape is unchanged — the
 * local-first patch in `index.tsx` addresses it exactly.
 */
export function sessionsSearchQueryKey(spaceId: string | null, q: string): readonly unknown[] {
  return [...sessionsQueryKey(spaceId), "search", q];
}

/**
 * One conversation, read by id whatever the list's filter, under the shell's typed-client key for
 * `GET /api/orgs/{orgId}/chat/sessions/{id}`: one cache for the module and the host, which
 * refetches it on the conversation's session signal.
 */
export function sessionQueryKey(orgId: string | undefined, id: string | null): readonly unknown[] {
  return ["get", "/api/orgs/{orgId}/chat/sessions/{id}", { params: { path: { orgId, id } } }];
}

/**
 * The history a conversation's runtime is seeded with, read once per mount. Its own key, which no
 * session signal matches: the runtime takes the first answer only, so a refetch would cost the
 * whole history for nothing.
 */
export function historyQueryKey(orgId: string | undefined, id: string): readonly unknown[] {
  return ["chat", "history", orgId, id];
}

export interface SessionsPage {
  data: SessionSummary[];
  hasMore: boolean;
}

export type SessionsCache = InfiniteData<SessionsPage, string | undefined>;

export async function fetchSessionsPage(
  transport: ChatTransport,
  startingAfter: string | undefined,
  q?: string,
): Promise<SessionsPage> {
  const params = new URLSearchParams();
  if (transport.spaceId) params.set("spaceId", transport.spaceId);
  if (q) params.set("q", q);
  if (startingAfter) params.set("startingAfter", startingAfter);
  const query = params.size > 0 ? `?${params}` : "";
  const res = await transport.request(chatPath(transport, `/sessions${query}`));
  const body = (await res.json()) as Partial<SessionsPage>;
  return { data: body.data ?? [], hasMore: body.hasMore ?? false };
}

/** Patch every loaded page (`first` = head page); an absent cache stays absent unless seeded. */
export function patchSessionsCache(
  prev: SessionsCache | undefined,
  fn: (rows: SessionSummary[], first: boolean) => SessionSummary[],
  seed?: SessionSummary,
): SessionsCache | undefined {
  if (!prev)
    return seed ? { pages: [{ data: [seed], hasMore: false }], pageParams: [undefined] } : prev;
  return { ...prev, pages: prev.pages.map((p, i) => ({ ...p, data: fn(p.data, i === 0) })) };
}

/**
 * One filtered list as a turn of conversation `id` starts: its row marked generating and moved to
 * the head. A conversation created by this turn (`created`: its origin and limit) is not listed
 * yet, so its row is made, with its origin as the only space it touched. An existing one missing
 * from the list stays out: the filter excludes it, and only the server knows which spaces it touched.
 */
export function startTurnRow(
  prev: SessionsCache | undefined,
  turn: {
    id: string;
    created: { originSpaceId: string | null; restricted: boolean } | null;
    now: string;
  },
): SessionsCache | undefined {
  const { id, created, now } = turn;
  const listed: SessionSummary | undefined = prev?.pages
    .flatMap((p) => p.data)
    .find((s) => s.id === id);
  const base =
    listed ??
    (created && {
      id,
      title: null,
      unread: false,
      spaceId: created.originSpaceId,
      restricted: created.restricted,
      space_ids: created.originSpaceId ? [created.originSpaceId] : [],
    });
  if (!base) return prev;
  const row: SessionSummary = { ...base, generating: true, updatedAt: now };
  return patchSessionsCache(
    prev,
    (rows, first) => [...(first ? [row] : []), ...rows.filter((s) => s.id !== id)],
    row,
  );
}

/**
 * Reflect a deleted conversation in every cached list, whatever its space filter or title search.
 * Cancels the in-flight reads first so a stale (pre-delete) response cannot land afterwards and
 * resurrect the row; the server is already updated and the periodic poll reconciles later drift.
 */
export async function dropSessionFromLists(queryClient: QueryClient, id: string): Promise<void> {
  await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
  queryClient.setQueriesData<SessionsCache>({ queryKey: SESSIONS_QUERY_KEY }, (prev) =>
    patchSessionsCache(prev, (rows) => rows.filter((s) => s.id !== id)),
  );
}

/** Flatten the loaded pages; a row seen twice (bumped mid-walk) keeps its first occurrence. */
export function flattenSessions(cache: SessionsCache): SessionSummary[] {
  const seen = new Set<string>();
  return cache.pages.flatMap((p) => p.data.filter((s) => !seen.has(s.id) && seen.add(s.id)));
}

export async function renameSession(
  transport: ChatTransport,
  id: string,
  title: string,
): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}`), jsonInit("PATCH", { title }));
}

/**
 * Limit (`restricted: true`) or lift (`false`) the conversation's confinement to its origin space;
 * `spaceId` gives a conversation without an origin the one it is limited to.
 */
export async function setSessionLimit(
  transport: ChatTransport,
  id: string,
  limit: { restricted: boolean; spaceId?: string },
): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}`), jsonInit("PATCH", limit));
}

export async function deleteSession(transport: ChatTransport, id: string): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}`), { method: "DELETE" });
}

/** Mark the session read server-side (clears `unread`). Idempotent. */
export async function markSessionRead(transport: ChatTransport, id: string): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}/read`), { method: "PUT" });
}

/** Explicitly stop the server-side producer for an active conversation. */
export async function stopSession(transport: ChatTransport, id: string): Promise<void> {
  await transport.request(chatPath(transport, `/sessions/${id}/stop`), { method: "POST" });
}

/** The session's skills as a session DTO carries them. */
function storedSkillsOf(dto: { skill_discovery: boolean; pins: PinnedSkill[] }): StoredSkills {
  return { skillDiscovery: dto.skill_discovery, pins: dto.pins };
}

/** Apply the changed settings and read the confirmed selection. */
export async function updateSessionSkills(
  transport: ChatTransport,
  id: string,
  change: SkillSettingsPatch,
): Promise<StoredSkills> {
  const res = await transport.request(
    chatPath(transport, `/sessions/${id}/skills`),
    jsonInit("PATCH", change),
  );
  return storedSkillsOf((await res.json()) as { skill_discovery: boolean; pins: PinnedSkill[] });
}

/** A stored message node as returned by `GET /sessions/:id`. */
interface StoredMessage {
  id: string;
  content: Record<string, unknown>;
}

/** A conversation as the detail route serves it: its row, history, skill selection and usage. */
export interface SessionHistory extends SessionSummary {
  messages: UIMessage[];
  skills: StoredSkills;
  createdAt: string;
  /** Tokens of every model call metered for the conversation's turns. */
  usage: TokenUsage;
}

/**
 * Stored `content` is the ai-sdk/v6 UIMessage minus its id (the id rides in the
 * row), so we reconstruct `{ id, ...content }`. `null` when the caller has no
 * such conversation (the route's 404).
 */
export async function loadHistory(
  transport: ChatTransport,
  id: string,
): Promise<SessionHistory | null> {
  let res: Response;
  try {
    res = await transport.request(chatPath(transport, `/sessions/${id}`));
  } catch (error) {
    if (errorStatus(error) === 404) return null;
    throw error;
  }
  const { messages, skill_discovery, pins, ...row } = (await res.json()) as SessionSummary & {
    messages?: StoredMessage[];
    skill_discovery: boolean;
    pins: PinnedSkill[];
    createdAt: string;
    usage: TokenUsage;
  };
  return {
    ...row,
    // Row `id` LAST: a stray `id` inside a stored `content` must not win.
    messages: (messages ?? []).map((e) => ({ ...e.content, id: e.id }) as UIMessage),
    skills: storedSkillsOf({ skill_discovery, pins }),
  };
}

/**
 * The conversation `id` (`null`: none, nothing read). Fresh by push: the host's realtime refetches
 * it on the conversation's session signal, never on a timer. Waits for the transport.
 */
export function sessionQuery(transport: ChatTransport | null | undefined, id: string | null) {
  return queryOptions({
    queryKey: sessionQueryKey(transport?.orgId, id),
    queryFn: transport && id ? () => loadHistory(transport, id) : skipToken,
    staleTime: Infinity,
    // Read again on every mount: nothing else refreshes a conversation no one was watching.
    gcTime: 0,
  });
}

/** What seeds a conversation's runtime: its stored messages. */
export type SessionSeed = Pick<SessionHistory, "messages">;

/**
 * The seed of conversation `id` (`null`: no such conversation), read through the conversation's
 * own entry so a read the host holds or has in flight serves both. Read on every mount, never again:
 * the row's live fields (limit, unread, `generating`) come from the session row, not from here.
 */
export function sessionSeedQuery(
  queryClient: QueryClient,
  transport: ChatTransport | null | undefined,
  id: string,
) {
  return queryOptions({
    queryKey: historyQueryKey(transport?.orgId, id),
    queryFn: transport
      ? async (): Promise<SessionSeed | null> => {
          // A cached entry has an observer, which the session signal keeps fresh.
          const history = await queryClient.fetchQuery(sessionQuery(transport, id));
          return history && { messages: history.messages };
        }
      : skipToken,
    staleTime: Infinity,
    gcTime: 0,
  });
}
