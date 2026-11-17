// SPDX-License-Identifier: Apache-2.0

/**
 * The open conversation's origin space and limit (`ConversationScope`), and what its first turn
 * carries. Before the first message the conversation does not exist: its origin is the space the
 * host has selected (or, without one, the space the user limits it to) and its limit a local
 * choice, both sent with that message. Afterwards the limit is the server's, changed by a PATCH
 * (optimistic, rolled back on failure, refused while a turn generates) that keeps the session
 * detail and every list row in step. The origin is immutable once set: a conversation without one
 * takes it only by being limited to it.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ConversationCreation } from "./chat-route.ts";
import type { ConversationScope } from "./conversation-scope.ts";
import type { ChatTransport } from "./runtime-context.ts";
import { useLatest } from "./use-latest.ts";
import {
  patchSessionsCache,
  sessionQueryKey,
  SESSIONS_QUERY_KEY,
  setSessionLimit,
  type SessionHistory,
  type SessionsCache,
  type SessionSummary,
} from "./sessions.ts";

/** A conversation's origin space and limit. */
export interface Limit {
  spaceId: string | null;
  restricted: boolean;
}

/** The creation fields of a first turn: only what is set, so « Tous les espaces » sends neither. */
export function creationFields(created: Limit): ConversationCreation {
  return {
    ...(created.spaceId && { spaceId: created.spaceId }),
    ...(created.spaceId && created.restricted && { restricted: true as const }),
  };
}

/** `spaceIds` (a touched set) with `origin` first: the origin is touched by definition. */
function withOrigin(spaceIds: readonly string[], origin: string | null): string[] {
  return origin ? [origin, ...spaceIds.filter((id) => id !== origin)] : [...spaceIds];
}

/** Rewrites the conversation on its session detail and on every cached list row. */
function writeRow(
  queryClient: QueryClient,
  transport: ChatTransport,
  id: string,
  update: <T extends SessionSummary>(row: T) => T,
): void {
  queryClient.setQueryData<SessionHistory | null>(sessionQueryKey(transport.orgId, id), (prev) =>
    prev ? update(prev) : prev,
  );
  queryClient.setQueriesData<SessionsCache>({ queryKey: SESSIONS_QUERY_KEY }, (prev) =>
    patchSessionsCache(prev, (rows) => rows.map((s) => (s.id === id ? update(s) : s))),
  );
}

/** What the limit changes on a cached copy of the conversation. */
type LimitFields = Pick<SessionSummary, "spaceId" | "restricted" | "space_ids">;

/** The limit fields of every cached copy of the conversation, by cache key, to restore them. */
function snapshotRows(
  queryClient: QueryClient,
  transport: ChatTransport,
  id: string,
): Array<{ queryKey: readonly unknown[]; fields: LimitFields; detail: boolean }> {
  const fieldsOf = ({ spaceId, restricted, space_ids }: SessionSummary): LimitFields => ({
    spaceId,
    restricted,
    space_ids,
  });
  const detailKey = sessionQueryKey(transport.orgId, id);
  const detail = queryClient.getQueryData<SessionHistory | null>(detailKey);
  const lists = queryClient
    .getQueriesData<SessionsCache>({ queryKey: SESSIONS_QUERY_KEY })
    .flatMap(([queryKey, cache]) => {
      const row = cache?.pages.flatMap((page) => page.data).find((s) => s.id === id);
      return row ? [{ queryKey, fields: fieldsOf(row), detail: false }] : [];
    });
  return detail
    ? [{ queryKey: detailKey, fields: fieldsOf(detail), detail: true }, ...lists]
    : lists;
}

/**
 * Limits or lifts an existing conversation, giving one without an origin the space `next` names:
 * shown at once (`show` and the caches), every cached copy put back as it was when the server
 * refuses, and the refusal rethrown for the host's error handling.
 */
export async function changeLimit(args: {
  queryClient: QueryClient;
  transport: ChatTransport;
  id: string;
  next: Limit;
  previous: Limit;
  show: (limit: Limit) => void;
}): Promise<void> {
  const { queryClient, transport, id, next, previous, show } = args;
  const gained = next.spaceId !== previous.spaceId ? next.spaceId : null;
  const snapshot = snapshotRows(queryClient, transport, id);
  show(next);
  writeRow(queryClient, transport, id, (row) => ({
    ...row,
    ...next,
    space_ids: withOrigin(row.space_ids, next.spaceId),
  }));
  try {
    await setSessionLimit(transport, id, {
      restricted: next.restricted,
      ...(gained !== null && { spaceId: gained }),
    });
  } catch (error) {
    show(previous);
    for (const { queryKey, fields, detail } of snapshot) {
      if (detail) {
        queryClient.setQueryData<SessionHistory | null>(queryKey, (prev) =>
          prev ? { ...prev, ...fields } : prev,
        );
      } else {
        queryClient.setQueryData<SessionsCache>(queryKey, (prev) =>
          patchSessionsCache(prev, (rows) =>
            rows.map((s) => (s.id === id ? { ...s, ...fields } : s)),
          ),
        );
      }
    }
    throw error;
  }
}

interface UseConversationLimitArgs {
  id: string;
  transport: ChatTransport | undefined;
  /** The conversation existed when the page opened (its id came from the URL). */
  persistedAtMount: boolean;
  /** Its stored origin and limit, once its session row is known. */
  stored: Pick<SessionSummary, "spaceId" | "restricted"> | undefined;
  /** The space a new conversation would take as origin (selected and acted in), if any. */
  selectedSpaceId: string | undefined;
  /** A turn is generating: the server refuses to change the limit until it ends. */
  generating: boolean;
}

/** Before the first message: the space the user limited to without a selected one, and the limit. */
interface Draft {
  chosenSpaceId: string | null;
  restricted: boolean;
}

/**
 * A conversation started in a space is limited to it unless the user lifts the limit before
 * sending; from the overview it has no origin, so it starts unlimited until one is chosen.
 */
const INITIAL_DRAFT: Draft = { chosenSpaceId: null, restricted: true };

/** The origin of a conversation not created yet: the space chosen, else the selected one. */
function draftOrigin(draft: Draft, selectedSpaceId: string | undefined): string | null {
  return draft.chosenSpaceId ?? selectedSpaceId ?? null;
}

export function useConversationLimit({
  id,
  transport,
  persistedAtMount,
  stored,
  selectedSpaceId,
  generating,
}: UseConversationLimitArgs): {
  scope: ConversationScope;
  /** The creation fields of the turn being sent: none for a conversation that existed at mount. */
  getCreation: () => ConversationCreation | undefined;
} {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<Limit | null>(null);
  // Frozen at the first message: a retry after a failed first turn keeps it. Every later turn
  // carries it too, and the server reads it only on the turn that creates the conversation.
  const frozen = useRef<Limit | null>(null);
  // A draft answers the space selected when it was made: selecting another (or « Tous les
  // espaces ») starts the conversation over from that one, as a new conversation there would.
  const [made, setMade] = useState<{ draft: Draft; under: string | undefined }>({
    draft: INITIAL_DRAFT,
    under: selectedSpaceId,
  });
  const draft = made.under === selectedSpaceId ? made.draft : INITIAL_DRAFT;
  const setDraft = useCallback(
    (next: Draft) => setMade({ draft: next, under: selectedSpaceId }),
    [selectedSpaceId],
  );
  // The limit the user last set on a conversation that exists, over what was loaded or frozen.
  const [override, setOverride] = useState<Limit>();

  const exists = persistedAtMount || created !== null;
  const current: Limit = override ?? stored ?? created ?? { spaceId: null, restricted: false };
  const newOrigin = draftOrigin(draft, selectedSpaceId);
  const originSpaceId = exists ? current.spaceId : newOrigin;
  const draftLimited = draft.restricted && newOrigin !== null;
  const restricted = exists ? current.restricted : draftLimited;

  // Read at request time: the turn's transport outlives the render that built it. What it
  // freezes is what the scope shows, so the first message carries what the composer said.
  const getLatest = useLatest<Limit>({ spaceId: newOrigin, restricted: draftLimited });
  const getCreation = useCallback((): ConversationCreation | undefined => {
    if (persistedAtMount) return undefined;
    if (!frozen.current) {
      frozen.current = getLatest();
      setCreated(frozen.current);
    }
    return creationFields(frozen.current);
  }, [persistedAtMount, getLatest]);

  const { mutate, isPending } = useMutation({
    mutationFn: (next: Limit) =>
      changeLimit({
        queryClient,
        transport: transport!,
        id,
        next,
        previous: current,
        show: setOverride,
      }),
    // The server's answer is now the stored value: drop the local override so a later change of
    // the stored limit (another tab, a refetch) is not masked by it.
    onSettled: () => {
      setOverride(undefined);
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey(transport!.orgId, id) });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onSuccess: (_data, next) => {
      setCreated((prev) => (prev ? next : prev));
    },
  });

  // One change at a time: a second one would roll back to the first's optimistic value.
  const change = useCallback(
    (next: Limit) => {
      if (transport && !isPending) mutate(next);
    },
    [transport, isPending, mutate],
  );
  const limitTo = useCallback(
    (spaceId: string) => {
      if (!exists) {
        setDraft({ chosenSpaceId: spaceId === selectedSpaceId ? null : spaceId, restricted: true });
        return;
      }
      // The origin never changes once set: `spaceId` is taken only by a conversation without one.
      change({ spaceId: current.spaceId ?? spaceId, restricted: true });
    },
    [exists, selectedSpaceId, setDraft, change, current.spaceId],
  );
  const lift = useCallback(() => {
    if (!exists) {
      // A chosen space goes with the limit: the draft is back to having no origin.
      setDraft({ chosenSpaceId: null, restricted: draft.chosenSpaceId !== null });
      return;
    }
    change({ spaceId: current.spaceId, restricted: false });
  }, [exists, setDraft, draft.chosenSpaceId, change, current.spaceId]);

  const scope = useMemo(
    () => ({ originSpaceId, restricted, generating, pending: isPending, limitTo, lift }),
    [originSpaceId, restricted, generating, isPending, limitTo, lift],
  );
  return { scope, getCreation };
}
