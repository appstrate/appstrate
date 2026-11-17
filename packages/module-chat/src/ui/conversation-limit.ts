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
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
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
type Limit = Pick<SessionSummary, "spaceId" | "restricted">;

/** The creation fields of a first turn: only what is set, so « Tous les espaces » sends neither. */
export function creationFields(created: Limit): ConversationCreation {
  return {
    ...(created.spaceId && { spaceId: created.spaceId }),
    ...(created.spaceId && created.restricted && { restricted: true as const }),
  };
}

type LimitChange = { id: string; restricted: boolean; spaceId?: string };

function limitedRow<T extends SessionSummary>(row: T, change: LimitChange): T {
  if (row.id !== change.id) return row;
  const spaceId = change.spaceId ?? row.spaceId;
  return {
    ...row,
    spaceId,
    restricted: change.restricted,
    space_ids: change.spaceId
      ? [change.spaceId, ...row.space_ids.filter((id) => id !== change.spaceId)]
      : row.space_ids,
  };
}

const limitMutationKey = (orgId: string | undefined) => ["chat-session-limit", orgId] as const;

/** List and detail readers project pending changes over their latest server row. A refusal
 * simply drops the projection, including when a refetch changed the row during the PATCH. */
export function usePendingSessionLimits(orgId: string | undefined) {
  const pending = useMutationState({
    filters: { mutationKey: limitMutationKey(orgId), status: "pending" },
    select: (mutation) => mutation.state.variables as LimitChange,
  });
  return useCallback(
    <T extends SessionSummary>(row: T): T => {
      const change = pending.find((limit) => limit.id === row.id);
      return change ? limitedRow(row, change) : row;
    },
    [pending],
  );
}

interface UseConversationLimitArgs {
  id: string;
  transport: ChatTransport | undefined;
  /** The conversation existed when the page opened (its id came from the URL). */
  persistedAtMount: boolean;
  /** Its stored origin and limit, once its session row is known. */
  stored: Limit | undefined;
  /** The space a new conversation would take as origin (selected and acted in), if any. */
  selectedSpaceId: string | undefined;
  /** A turn is generating: the server refuses to change the limit until it ends. */
  generating: boolean;
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
  // A draft belongs to the current selection. Changing space resets both its origin and limit.
  const initialDraft = { spaceId: selectedSpaceId ?? null, restricted: !!selectedSpaceId };
  const [draft, setDraft] = useState({ ...initialDraft, under: selectedSpaceId });
  const exists = persistedAtMount || created !== null;
  if (!exists && draft.under !== selectedSpaceId)
    setDraft({ ...initialDraft, under: selectedSpaceId });
  const current = stored ?? created ?? { spaceId: null, restricted: false };

  // Read at request time: the turn's transport outlives the render that built it. What it
  // freezes is what the scope shows, so the first message carries what the composer said.
  const getLatest = useLatest(draft);
  const getCreation = useCallback((): ConversationCreation | undefined => {
    if (persistedAtMount) return undefined;
    if (!frozen.current) {
      frozen.current = getLatest();
      setCreated(frozen.current);
    }
    return creationFields(frozen.current);
  }, [persistedAtMount, getLatest]);

  const detailKey = sessionQueryKey(transport?.orgId, id);
  const { mutate, isPending, variables } = useMutation({
    mutationKey: limitMutationKey(transport?.orgId),
    mutationFn: ({ id: sessionId, ...patch }: LimitChange) =>
      setSessionLimit(transport!, sessionId, patch),
    onSuccess: (_, change) => {
      setCreated(
        (prev) =>
          prev && { spaceId: change.spaceId ?? prev.spaceId, restricted: change.restricted },
      );
      queryClient.setQueryData<SessionHistory | null>(
        detailKey,
        (row) => row && limitedRow(row, change),
      );
      queryClient.setQueriesData<SessionsCache>({ queryKey: SESSIONS_QUERY_KEY }, (cache) =>
        patchSessionsCache(cache, (rows) => rows.map((row) => limitedRow(row, change))),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  const pending = isPending ? variables : undefined;
  const originSpaceId = exists ? (pending?.spaceId ?? current.spaceId) : draft.spaceId;
  const restricted = exists ? (pending?.restricted ?? current.restricted) : draft.restricted;
  const change = useCallback(
    (next: Limit) => {
      if (!exists) setDraft({ ...next, under: selectedSpaceId });
      else if (transport && !isPending) {
        mutate({
          id,
          restricted: next.restricted,
          ...(current.spaceId === null && next.spaceId && { spaceId: next.spaceId }),
        });
      }
    },
    [exists, transport, isPending, mutate, id, current.spaceId, selectedSpaceId],
  );
  const limitTo = useCallback(
    (spaceId: string) => change({ spaceId: originSpaceId ?? spaceId, restricted: true }),
    [change, originSpaceId],
  );
  const lift = useCallback(
    () =>
      change({ spaceId: exists ? originSpaceId : (selectedSpaceId ?? null), restricted: false }),
    [change, exists, originSpaceId, selectedSpaceId],
  );

  const scope = useMemo(
    () => ({ originSpaceId, restricted, generating, pending: isPending, limitTo, lift }),
    [originSpaceId, restricted, generating, isPending, limitTo, lift],
  );
  return { scope, getCreation };
}
