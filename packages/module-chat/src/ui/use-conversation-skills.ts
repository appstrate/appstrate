// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's skills. Once the server's row is read, the session detail is the truth and a
 * pending change is projected over that row until its PATCH completes. Until then, a local selection the first
 * turn sends as `pins` / `skill_discovery`. A change made after that turn left and before its row
 * is read stays local, the row is read again, and the change is PATCHed over it; a turn that
 * created no row leaves the selection to the next turn.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatSkillSelection, SkillSettingsPatch } from "../skills.ts";
import {
  DEFAULT_STORED_SKILLS,
  citedSkillIds,
  effectiveSkills,
  pinIds,
  selectionOf,
  withPin,
  withSelection,
  type EffectiveSkills,
  type StoredSkills,
} from "./chat-skills.ts";
import {
  sessionQuery,
  sessionQueryKey,
  updateSessionSkills,
  type SessionHistory,
} from "./sessions.ts";
import type { ChatTransport } from "./runtime-context.ts";
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
  /** What the turn being sent creates the conversation with; `undefined` once the row is read. */
  takeForTurn: () => ChatSkillSelection | undefined;
}

const DEFAULT_SELECTION = selectionOf(DEFAULT_STORED_SKILLS);

const skillsMutationKey = (orgId: string | undefined, id: string) =>
  ["chat-session-skills", orgId, id] as const;

function applyChange(
  selection: ChatSkillSelection,
  change: SkillSettingsPatch,
): ChatSkillSelection {
  const next = {
    pinnedSkills: change.pins ?? selection.pinnedSkills,
    skillDiscovery: change.skill_discovery ?? selection.skillDiscovery,
  };
  return change.pin ? withPin(next, change.pin.id, change.pin.pinned) : next;
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
  const detail = useQuery({
    ...sessionQuery(transport, id),
    enabled: persisted || sent,
    select: selectSkills,
  });
  // Read when a turn is built, outside render: a ref, mirrored in state for the render.
  const [selection, setSelectionState] = useState(DEFAULT_SELECTION);
  const selectionRef = useRef(DEFAULT_SELECTION);
  const setSelection = useCallback((next: ChatSkillSelection) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);
  // The local selection holds a change no turn and no PATCH has carried.
  const unsentRef = useRef<SkillSettingsPatch[]>([]);

  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) => mutation.state.variables as SkillSettingsPatch,
  });
  const held = detail.data != null;
  const base = useMemo(
    () => detail.data ?? withSelection(DEFAULT_STORED_SKILLS, selection),
    [detail.data, selection],
  );
  // The changes in flight over the server's state: a read landing mid-PATCH cannot hide them.
  const skills = useMemo(
    () =>
      pending.length ? withSelection(base, pending.reduce(applyChange, selectionOf(base))) : base,
    [base, pending],
  );

  const heldRow = useCallback(
    () => queryClient.getQueryData<SessionHistory | null>(detailKey) ?? null,
    [queryClient, detailKey],
  );
  const isLast = useCallback(
    () => queryClient.isMutating({ mutationKey }) <= 1,
    [queryClient, mutationKey],
  );

  const { mutate } = useMutation({
    mutationKey,
    // Preserve the order of this tab's edits to the same pin.
    scope: { id: `chat-session-skills:${orgId}:${id}` },
    mutationFn: (change: SkillSettingsPatch) => updateSessionSkills(transport!, id, change),
    onSuccess: (stored) => {
      queryClient.setQueryData<SessionHistory | null>(
        detailKey,
        (row) => row && { ...row, skills: stored },
      );
    },
    onSettled: () => {
      if (isLast()) void queryClient.invalidateQueries({ queryKey: detailKey, exact: true });
    },
  });

  // The row is read: a change it does not hold yet is sent over it.
  const stored = detail.data;
  useEffect(() => {
    if (stored && transport) {
      for (const edit of unsentRef.current.splice(0)) mutate(edit);
    }
  }, [stored, transport, mutate]);

  /** Reads the row again: after the first turn it may hold the conversation now. */
  const reread = useCallback(
    () => queryClient.refetchQueries({ queryKey: detailKey, exact: true }),
    [queryClient, detailKey],
  );

  const getEnabled = useLatest(enabled);
  const change = useCallback(
    (edit: SkillSettingsPatch) => {
      if (!getEnabled()) return;
      if (heldRow()) {
        if (transport) {
          for (const earlier of unsentRef.current.splice(0)) mutate(earlier);
          mutate(edit);
        }
        return;
      }
      // A conversation held at mount changes once its row is read: the defaults are not its choice.
      if (persisted) return;
      setSelection(applyChange(selectionRef.current, edit));
      unsentRef.current.push(edit);
      // A query not enabled yet (no turn left) is not read.
      void reread();
    },
    [getEnabled, heldRow, transport, mutate, persisted, setSelection, reread],
  );

  const takeForTurn = useCallback((): ChatSkillSelection | undefined => {
    if (!getEnabled() || heldRow()) return undefined;
    unsentRef.current = [];
    setSent(true);
    return selectionRef.current;
  }, [getEnabled, heldRow]);

  return useMemo(
    () => ({
      skills,
      held,
      setPin: (packageId: string, on: boolean) => change({ pin: { id: packageId, pinned: on } }),
      setDiscovery: (on: boolean) => change({ skill_discovery: on }),
      reset: () => change({ pins: [], skill_discovery: true }),
      takeForTurn,
    }),
    [skills, held, change, takeForTurn],
  );
}

/** The open conversation's skills; `null` where the panel is not offered (no skill is listed). */
const ConversationSkillsContext = createContext<ConversationSkillsState | null>(null);

export const ConversationSkillsProvider = ConversationSkillsContext.Provider;

export const useConversationSkillsContext = () => useContext(ConversationSkillsContext);

const NO_DRAFT_SKILLS = effectiveSkills([], []);

/** The pinned skills and those the composer's draft cites: computed once per draft. */
const DraftSkillsContext = createContext<EffectiveSkills>(NO_DRAFT_SKILLS);

export const DraftSkillsProvider = DraftSkillsContext.Provider;

export const useDraftSkills = () => useContext(DraftSkillsContext);

/** The draft's skills over the conversation's pins (`null`: no panel, so none is counted). */
export function useDraftSkillsOf(skills: StoredSkills | null, draft: string): EffectiveSkills {
  return useMemo(
    () => (skills ? effectiveSkills(pinIds(skills), citedSkillIds(draft)) : NO_DRAFT_SKILLS),
    [skills, draft],
  );
}
