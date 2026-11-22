// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's skills. Once the server holds its row, the session detail is the truth and a
 * change is a PATCH of the full set, written into the cached detail before it lands (rolled back
 * on a failure, which the host's mutation cache toasts). Before that, a local selection the first
 * turn sends as `pins` / `skill_discovery`; a PATCH answering 404 (the first turn created no row)
 * writes the selection back there.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { MAX_PINNED_SKILLS } from "../skills.ts";
import {
  DEFAULT_STORED_SKILLS,
  citedSkillIds,
  effectiveSkills,
  pinIds,
  selectionOf,
  withPin,
  withSelection,
  type EffectiveSkills,
  type SkillSelection,
  type StoredSkills,
} from "./chat-skills.ts";
import {
  sessionQuery,
  sessionQueryKey,
  updateSessionSkills,
  type SessionHistory,
} from "./sessions.ts";
import { errorStatus, type ChatTransport } from "./runtime-context.ts";
import { useLatest } from "./use-latest.ts";

export interface ConversationSkillsState {
  /** The server's skills with the pending changes written; the local selection before a row. */
  skills: StoredSkills;
  /** The server holds the conversation's row: a skill can be pinned from the thread. */
  held: boolean;
  setPin: (packageId: string, on: boolean) => void;
  setDiscovery: (on: boolean) => void;
  /** Back to the default selection: discovery on, no pin. */
  reset: () => void;
  /** Pins the skills a message cites before it is sent; resolves once the server holds them. */
  pinCited: (ids: readonly string[]) => Promise<void>;
  /** What the turn being sent creates the conversation with; `undefined` once the server holds it. */
  takeForTurn: () => SkillSelection | undefined;
}

const DEFAULT_SELECTION = selectionOf(DEFAULT_STORED_SKILLS);

const skillsMutationKey = (orgId: string | undefined, id: string) =>
  ["chat-session-skills", orgId, id] as const;

/** The latest selection in flight for the conversation, if any. */
function pendingSelection(
  queryClient: QueryClient,
  mutationKey: readonly unknown[],
): SkillSelection | undefined {
  const pending = queryClient.getMutationCache().findAll({ mutationKey, status: "pending" });
  return pending[pending.length - 1]?.state.variables as SkillSelection | undefined;
}

const selectSkills = (row: SessionHistory | null) => row?.skills ?? null;

export function useConversationSkills({
  transport,
  id,
  persisted,
  enabled,
}: {
  transport: ChatTransport | undefined;
  id: string;
  /** The server held the conversation at mount: there is a detail to read. */
  persisted: boolean;
  /** The user may change the skills: off, nothing is changed and nothing is sent. */
  enabled: boolean;
}): ConversationSkillsState {
  const queryClient = useQueryClient();
  const orgId = transport?.orgId;
  const detailKey = useMemo(() => sessionQueryKey(orgId, id), [orgId, id]);
  const mutationKey = useMemo(() => skillsMutationKey(orgId, id), [orgId, id]);
  // A conversation created in this mount is read once its first turn has left.
  const [sent, setSent] = useState(false);
  const sentRef = useRef(false);
  const detail = useQuery({
    ...sessionQuery(transport, id),
    enabled: persisted || sent,
    select: selectSkills,
  });
  // Read when a turn is built, outside render: a ref, mirrored in state for the render.
  const [selection, setSelectionState] = useState(DEFAULT_SELECTION);
  const selectionRef = useRef(DEFAULT_SELECTION);
  const setSelection = useCallback((next: SkillSelection) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);

  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) => mutation.state.variables as SkillSelection,
  });
  const latest = pending[pending.length - 1];
  const held = detail.data != null;
  const base = useMemo(
    () => detail.data ?? withSelection(DEFAULT_STORED_SKILLS, selection),
    [detail.data, selection],
  );
  // The changes in flight over the server's state: a read landing mid-PATCH cannot hide them.
  const skills = useMemo(() => (latest ? withSelection(base, latest) : base), [base, latest]);

  /** The full selection at call time: the last one in flight, else the cache, else the local one. */
  const current = useCallback((): SkillSelection => {
    const inFlight = pendingSelection(queryClient, mutationKey);
    if (inFlight) return inFlight;
    const row = queryClient.getQueryData<SessionHistory | null>(detailKey);
    return row ? selectionOf(row.skills) : selectionRef.current;
  }, [queryClient, mutationKey, detailKey]);
  const isLast = useCallback(
    () => queryClient.isMutating({ mutationKey }) <= 1,
    [queryClient, mutationKey],
  );

  const { mutate, mutateAsync } = useMutation({
    mutationKey,
    // One PATCH at a time, each carrying the full set computed over the previous ones: the server
    // applies them in order, so the last change made is the one it keeps.
    scope: { id: `chat-session-skills:${orgId}:${id}` },
    mutationFn: async (next: SkillSelection) => {
      try {
        return await updateSessionSkills(transport!, id, next);
      } catch (error) {
        if (!persisted && errorStatus(error) === 404) return null;
        throw error;
      }
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
      const previous = queryClient.getQueryData<SessionHistory | null>(detailKey);
      queryClient.setQueryData<SessionHistory | null>(
        detailKey,
        (row) => row && { ...row, skills: withSelection(row.skills, next) },
      );
      return { previous };
    },
    onSuccess: (stored, next) => {
      if (stored === null) setSelection(next);
      else
        queryClient.setQueryData<SessionHistory | null>(
          detailKey,
          (row) => row && { ...row, skills: stored },
        );
    },
    onError: (_error, _next, context) => {
      if (isLast() && context?.previous) queryClient.setQueryData(detailKey, context.previous);
    },
    onSettled: () => {
      if (isLast()) void queryClient.invalidateQueries({ queryKey: detailKey, exact: true });
    },
  });

  const getEnabled = useLatest(enabled);
  const exists = useCallback(() => persisted || sentRef.current, [persisted]);
  const change = useCallback(
    (apply: (selection: SkillSelection) => SkillSelection) => {
      if (!getEnabled()) return;
      const next = apply(current());
      if (!exists()) setSelection(next);
      else if (transport) mutate(next);
    },
    [getEnabled, current, exists, setSelection, transport, mutate],
  );

  const pinCited = useCallback(
    async (ids: readonly string[]) => {
      if (!getEnabled()) return;
      const now = current();
      const missing = ids.filter((skill) => !now.pins.includes(skill));
      if (missing.length === 0) return;
      const next = { ...now, pins: [...now.pins, ...missing].sort() };
      // The composer refuses such a draft; a stray call pins nothing.
      if (next.pins.length > MAX_PINNED_SKILLS) return;
      if (!exists()) setSelection(next);
      // A failure is toasted by the host; the message is still sent.
      else if (transport) await mutateAsync(next).catch(() => {});
    },
    [getEnabled, current, exists, setSelection, transport, mutateAsync],
  );

  const takeForTurn = useCallback((): SkillSelection | undefined => {
    if (!getEnabled() || queryClient.getQueryData(detailKey)) return undefined;
    sentRef.current = true;
    setSent(true);
    return selectionRef.current;
  }, [getEnabled, queryClient, detailKey]);

  return useMemo(
    () => ({
      skills,
      held,
      setPin: (packageId: string, on: boolean) => change((s) => withPin(s, packageId, on)),
      setDiscovery: (on: boolean) => change((s) => ({ ...s, skillDiscovery: on })),
      reset: () => change(() => DEFAULT_SELECTION),
      pinCited,
      takeForTurn,
    }),
    [skills, held, change, pinCited, takeForTurn],
  );
}

/** The open conversation's skills; `null` where the panel is not offered (no skill is listed). */
const ConversationSkillsContext = createContext<ConversationSkillsState | null>(null);

export const ConversationSkillsProvider = ConversationSkillsContext.Provider;

export const useConversationSkillsContext = () => useContext(ConversationSkillsContext);

/** The skills the composer's draft cites, and the pinned ones with them: computed once per draft. */
export interface DraftSkills {
  cited: readonly string[];
  effective: EffectiveSkills;
}

const NO_DRAFT_SKILLS: DraftSkills = { cited: [], effective: effectiveSkills([], []) };

const DraftSkillsContext = createContext<DraftSkills>(NO_DRAFT_SKILLS);

export const DraftSkillsProvider = DraftSkillsContext.Provider;

export const useDraftSkills = () => useContext(DraftSkillsContext);

/** The draft's skills over the conversation's pins (`null`: no panel, so none is counted). */
export function useDraftSkillsOf(skills: StoredSkills | null, draft: string): DraftSkills {
  return useMemo(() => {
    if (!skills) return NO_DRAFT_SKILLS;
    const cited = citedSkillIds(draft);
    return { cited, effective: effectiveSkills(pinIds(skills), cited) };
  }, [skills, draft]);
}
