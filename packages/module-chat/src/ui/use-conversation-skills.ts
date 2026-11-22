// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's skills: the server's (the session detail, which the host's realtime keeps
 * fresh) with what the user changed since applied on top. Only the changes are sent, with the next
 * turn. A turn the server accepted (a 2xx) applied them in its first statement, so once it has
 * ended and the detail has been read again, what it sent is dropped; a turn refused or failed
 * without an answer keeps them for the next one (they are idempotent). A change made while the
 * turn ran always rides with the next one.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatSkillChanges } from "../skills.ts";
import {
  DEFAULT_STORED_SKILLS,
  NO_SKILL_CHANGES,
  changeDiscovery,
  changePin,
  citeSkill,
  conversationSkills,
  hasSkillChanges,
  resetSkillChanges,
  subtractSkillChanges,
  type ConversationSkills,
  type SkillChangeBase,
} from "./chat-skills.ts";
import { sessionQuery, sessionQueryKey } from "./sessions.ts";
import type { ChatTransport } from "./runtime-context.ts";
import { useLatest } from "./use-latest.ts";

/** A turn that took the changes: its own object, so two turns sending equal changes never mix. */
interface SentTurn {
  readonly sent: ChatSkillChanges | undefined;
  accepted: boolean;
}

/** An ended turn: whether the server accepted it, and what to do once the detail was read again. */
export interface EndedTurn {
  accepted: boolean;
  settle: () => void;
}

/**
 * The user's changes and the turn carrying them, outside React: the transport reads and marks them
 * at request time, between renders.
 */
export function createSkillChanges() {
  let changes: ChatSkillChanges = NO_SKILL_CHANGES;
  let turn: SentTurn | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ChatSkillChanges) => {
    changes = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => changes,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Applies a change; `inFlight` is what the running turn sent, which a change may undo. */
    change: (
      apply: (current: ChatSkillChanges, inFlight: ChatSkillChanges | null) => ChatSkillChanges,
    ) => set(apply(changes, turn?.sent ?? null)),
    /** The changes the turn being sent carries (a copy), `undefined` when none. */
    take: (): ChatSkillChanges | undefined => {
      const sent = hasSkillChanges(changes)
        ? { ...changes, pin: [...changes.pin], unpin: [...changes.unpin] }
        : undefined;
      turn = { sent, accepted: false };
      return sent;
    },
    /** The server answered the turn being sent: accepted when 2xx. */
    answered: (accepted: boolean) => {
      if (turn) turn.accepted = accepted;
    },
    /** The turn ended; `null` when no turn was sent in this mount (a resumed one). */
    end: (): EndedTurn | null => {
      const ended = turn;
      if (!ended) return null;
      return {
        accepted: ended.accepted,
        settle: () => {
          // A turn sent since is in flight now.
          if (turn === ended) turn = null;
          if (ended.accepted && ended.sent) set(subtractSkillChanges(changes, ended.sent));
        },
      };
    },
  };
}

export interface SkillActions {
  togglePin: (packageId: string) => void;
  setDiscovery: (on: boolean) => void;
  /** Back to the default selection: discovery on, no pin. */
  reset: () => void;
}

export interface ConversationSkillsState {
  skills: ConversationSkills;
  actions: SkillActions;
  /** Pins the skills a sent message cites, before its request is built. */
  pinCited: (ids: readonly string[]) => void;
  /** The changes the turn being sent carries, `undefined` when none; marks them in flight. */
  takeChanges: () => ChatSkillChanges | undefined;
  /** The server answered the turn being sent: accepted when 2xx. */
  answered: (accepted: boolean) => void;
  /** The turn ended: read the detail again, then drop what an accepted turn sent. */
  settle: () => void;
}

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
  // A conversation created in this mount is read once its first turn was accepted (no
  // speculative 404); from then on the host's realtime keeps the detail fresh.
  const [exists, setExists] = useState(persisted);
  const detail = useQuery({
    ...sessionQuery(transport, id),
    enabled: exists,
    select: (row) => row?.skills,
  });
  const stored = detail.data ?? DEFAULT_STORED_SKILLS;
  const getStored = useLatest(stored);
  const getEnabled = useLatest(enabled);

  const [store] = useState(createSkillChanges);
  const changes = useSyncExternalStore(store.subscribe, store.get, store.get);
  const update = useCallback(
    (apply: (current: ChatSkillChanges, base: SkillChangeBase) => ChatSkillChanges) => {
      if (!getEnabled()) return;
      store.change((current, inFlight) => apply(current, { stored: getStored(), inFlight }));
    },
    [store, getEnabled, getStored],
  );

  const skills = useMemo(() => conversationSkills(stored, changes), [stored, changes]);

  const actions = useMemo<SkillActions>(() => {
    const pinnedBy = (current: ChatSkillChanges, base: SkillChangeBase) =>
      conversationSkills(base.stored, current).pinned;
    return {
      togglePin: (packageId) =>
        update((current, base) =>
          changePin(current, packageId, !pinnedBy(current, base).includes(packageId), base),
        ),
      setDiscovery: (on) => update((current, base) => changeDiscovery(current, on, base)),
      reset: () =>
        update((current, base) => resetSkillChanges(current, pinnedBy(current, base), base)),
    };
  }, [update]);

  const pinCited = useCallback(
    (ids: readonly string[]) => update((current) => ids.reduce(citeSkill, current)),
    [update],
  );

  const settle = useCallback(() => {
    const ended = store.end();
    if (!ended || !transport) return;
    if (ended.accepted) setExists(true);
    // The turn may have pinned a skill (the assistant's load) and judged each pin: read the detail
    // again, sharing a refetch the realtime signal already started; inactive included, so a
    // conversation created in this mount is read before its observer is enabled.
    void queryClient
      .invalidateQueries(
        { queryKey: sessionQueryKey(transport.orgId, id), refetchType: "all" },
        { cancelRefetch: false },
      )
      .then(ended.settle);
  }, [store, queryClient, transport, id]);

  return {
    skills,
    actions,
    pinCited,
    takeChanges: store.take,
    answered: store.answered,
    settle,
  };
}
