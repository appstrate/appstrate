// SPDX-License-Identifier: Apache-2.0

/**
 * The open conversation's origin space and limit (`ConversationScope`), and what its first turn
 * carries. Before the first message the conversation does not exist: its origin is the space the
 * host has selected (or, without one, the space the user limits it to) and its limit a local
 * choice, both sent with that message: the draft. Once that message is sent the draft stops
 * following the selection and stands for the conversation until a session row is known; every
 * later turn carries it too, and the server reads it only on the turn that creates the
 * conversation. Afterwards the limit is the server's, changed by a PATCH
 * (refused while a turn generates): every reader projects it while it is pending, and a success
 * writes it into the session detail and every list row. The origin is immutable once set: a conversation without one
 * takes it only by being limited to it.
 */

import { useCallback, useMemo, useState } from "react";
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

/** The limit changes in flight, read by every reader: a refusal simply drops them. */
function usePendingLimits(orgId: string | undefined): LimitChange[] {
  return useMutationState({
    filters: { mutationKey: limitMutationKey(orgId), status: "pending" },
    select: (mutation) => mutation.state.variables as LimitChange,
  });
}

/** List and detail readers project pending changes over their latest server row, so a refetch
 * during the PATCH keeps its own changes whatever the PATCH's outcome. */
export function usePendingSessionLimits(orgId: string | undefined) {
  const pending = usePendingLimits(orgId);
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
  // The first message was sent in this mount: the conversation exists, and a retry after a failed
  // first turn carries the same draft.
  const [sent, setSent] = useState(false);
  // Until then a draft belongs to the current selection: changing space resets its origin and limit.
  const initialDraft = { spaceId: selectedSpaceId ?? null, restricted: !!selectedSpaceId };
  const [draft, setDraft] = useState({ ...initialDraft, under: selectedSpaceId });
  const exists = persistedAtMount || sent;
  if (!exists && draft.under !== selectedSpaceId)
    setDraft({ ...initialDraft, under: selectedSpaceId });
  const current = stored ?? (sent ? draft : { spaceId: null, restricted: false });

  // Read at request time: the turn's transport outlives the render that built it, so the first
  // message carries what the composer said.
  const getLatest = useLatest(draft);
  const getCreation = useCallback((): ConversationCreation | undefined => {
    if (persistedAtMount) return undefined;
    setSent(true);
    return creationFields(getLatest());
  }, [persistedAtMount, getLatest]);

  const detailKey = sessionQueryKey(transport?.orgId, id);
  // The scope reads the same projection as the list and detail: it also covers a conversation
  // created in this mount that no list holds yet.
  const pending = usePendingLimits(transport?.orgId).find((limit) => limit.id === id);
  const isPending = pending !== undefined;
  const { mutate } = useMutation({
    mutationKey: limitMutationKey(transport?.orgId),
    mutationFn: ({ id: sessionId, ...patch }: LimitChange) =>
      setSessionLimit(transport!, sessionId, patch),
    onSuccess: (_, change) => {
      setDraft((prev) => ({
        ...prev,
        spaceId: change.spaceId ?? prev.spaceId,
        restricted: change.restricted,
      }));
      queryClient.setQueryData<SessionHistory | null>(
        detailKey,
        (row) => row && limitedRow(row, change),
      );
      queryClient.setQueriesData<SessionsCache>({ queryKey: SESSIONS_QUERY_KEY }, (cache) =>
        patchSessionsCache(cache, (rows) => rows.map((row) => limitedRow(row, change))),
      );
    },
  });

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
