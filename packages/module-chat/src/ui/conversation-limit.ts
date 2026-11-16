// SPDX-License-Identifier: Apache-2.0

/**
 * The open conversation's origin space and limit (`ConversationScope`), and what its first turn
 * carries. Before the first message the conversation does not exist: its origin is the space the
 * host has selected and its limit a local choice, both sent with that message. Afterwards the
 * origin is frozen and the limit is the server's, changed by a PATCH (optimistic, rolled back on
 * failure, refused while a turn generates) that keeps the session detail and every list row in step.
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
  setSessionRestricted,
  type SessionHistory,
  type SessionsCache,
} from "./sessions.ts";

/** The origin and limit a conversation started in this mount took, frozen at its first message. */
interface Created {
  spaceId: string | null;
  restricted: boolean;
}

/** The creation fields of a first turn: only what is set, so « Vue d'ensemble » sends neither. */
export function creationFields(created: Created): ConversationCreation {
  return {
    ...(created.spaceId && { spaceId: created.spaceId }),
    ...(created.spaceId && created.restricted && { restricted: true as const }),
  };
}

/** Writes `restricted` on the session detail and on every cached list row of the conversation. */
function writeRestricted(
  queryClient: QueryClient,
  transport: ChatTransport,
  id: string,
  restricted: boolean,
): void {
  queryClient.setQueryData<SessionHistory | null>(sessionQueryKey(transport.orgId, id), (prev) =>
    prev ? { ...prev, restricted } : prev,
  );
  queryClient.setQueriesData<SessionsCache>({ queryKey: SESSIONS_QUERY_KEY }, (prev) =>
    patchSessionsCache(prev, (rows) => rows.map((s) => (s.id === id ? { ...s, restricted } : s))),
  );
}

/**
 * Limits or lifts an existing conversation: shown at once (`show` and the caches), rolled back to
 * `previous` when the server refuses, and the refusal rethrown for the host's error handling.
 */
export async function changeLimit(args: {
  queryClient: QueryClient;
  transport: ChatTransport;
  id: string;
  next: boolean;
  previous: boolean;
  show: (restricted: boolean) => void;
}): Promise<void> {
  const { queryClient, transport, id, next, previous, show } = args;
  show(next);
  writeRestricted(queryClient, transport, id, next);
  try {
    await setSessionRestricted(transport, id, next);
  } catch (error) {
    show(previous);
    writeRestricted(queryClient, transport, id, previous);
    throw error;
  }
}

interface UseConversationLimitArgs {
  id: string;
  transport: ChatTransport | undefined;
  /** The conversation existed when the page opened (its id came from the URL). */
  persistedAtMount: boolean;
  /** Its stored origin and limit, once the detail has loaded. */
  stored: Pick<SessionHistory, "spaceId" | "restricted"> | undefined;
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
  const [created, setCreated] = useState<Created | null>(null);
  // Frozen at the first message: a retry after a failed first turn keeps it. Every later turn
  // carries it too, and the server ignores it once the conversation exists.
  const frozen = useRef<Created | null>(null);
  // A conversation started in a space is limited to it unless the user lifts the limit before
  // sending; from the overview there is no origin to limit to, so it starts unlimited.
  const [draftRestricted, setDraftRestricted] = useState(true);
  // The limit the user last set on a conversation that exists, over what was loaded or frozen.
  const [override, setOverride] = useState<boolean>();

  const exists = persistedAtMount || created !== null;
  const originSpaceId = persistedAtMount
    ? (stored?.spaceId ?? null)
    : created
      ? created.spaceId
      : (selectedSpaceId ?? null);
  const restricted = exists
    ? (override ?? (persistedAtMount ? stored?.restricted : created?.restricted) ?? false)
    : draftRestricted && originSpaceId !== null;

  // Read at request time: the turn's transport outlives the render that built it.
  const getLatest = useLatest({ selectedSpaceId, draftRestricted });
  const getCreation = useCallback((): ConversationCreation | undefined => {
    if (persistedAtMount) return undefined;
    if (!frozen.current) {
      const { selectedSpaceId: space, draftRestricted: draft } = getLatest();
      frozen.current = { spaceId: space ?? null, restricted: draft && !!space };
      setCreated(frozen.current);
    }
    return creationFields(frozen.current);
  }, [persistedAtMount, getLatest]);

  const { mutate, isPending } = useMutation({
    mutationFn: (next: boolean) =>
      changeLimit({
        queryClient,
        transport: transport!,
        id,
        next,
        previous: restricted,
        show: setOverride,
      }),
  });

  // One change at a time: a second one would roll back to the first's optimistic value.
  const setRestricted = useCallback(
    (next: boolean) => {
      if (!exists) setDraftRestricted(next);
      else if (transport && !isPending) mutate(next);
    },
    [exists, transport, isPending, mutate],
  );

  const scope = useMemo(
    () => ({ originSpaceId, restricted, generating, setRestricted }),
    [originSpaceId, restricted, generating, setRestricted],
  );
  return { scope, getCreation };
}
