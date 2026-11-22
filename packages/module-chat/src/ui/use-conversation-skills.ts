// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's skills: the server's (the session detail, which the host's realtime keeps
 * fresh) with what the user changed since applied on top. Only the changes are sent, with the next
 * turn; once that turn has ended and the detail has been read again, each change the server shows
 * is dropped. A change made while the turn ran is not: it rides with the next one.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatSkillChanges } from "../skills.ts";
import {
  DEFAULT_STORED_SKILLS,
  NO_SKILL_CHANGES,
  changeDiscovery,
  changePin,
  conversationSkills,
  hasSkillChanges,
  resetSkillChanges,
  settleSkillChanges,
  type ConversationSkills,
  type SkillChangeBase,
} from "./chat-skills.ts";
import { sessionQuery } from "./sessions.ts";
import type { ChatTransport } from "./runtime-context.ts";
import { useLatest } from "./use-latest.ts";

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
  /** The turn ended: read the detail again, then drop what the server shows of what the turn sent. */
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
  // A conversation created in this mount is not read before its first turn has settled (no
  // speculative 404): `settle` reads it then, and this observer shows what that read cached.
  const detail = useQuery({
    ...sessionQuery(transport, id),
    enabled: persisted,
    select: (row) => row?.skills,
  });
  const stored = detail.data ?? DEFAULT_STORED_SKILLS;
  const getStored = useLatest(stored);
  const getEnabled = useLatest(enabled);

  const [changes, setChanges] = useState<ChatSkillChanges>(NO_SKILL_CHANGES);
  // The transport reads the changes at request time, a change not rendered yet included.
  const changesRef = useRef(changes);
  // What the turn in flight sent: a change undoing one of these must reach the server.
  const inFlight = useRef<ChatSkillChanges | null>(null);
  const update = useCallback(
    (change: (current: ChatSkillChanges, base: SkillChangeBase) => ChatSkillChanges) => {
      if (!getEnabled()) return;
      const next = change(changesRef.current, {
        stored: getStored(),
        inFlight: inFlight.current,
      });
      changesRef.current = next;
      setChanges(next);
    },
    [getEnabled, getStored],
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
    (ids: readonly string[]) =>
      update((current, base) =>
        ids.reduce((next, packageId) => changePin(next, packageId, true, base), current),
      ),
    [update],
  );

  const takeChanges = useCallback(() => {
    const sent = hasSkillChanges(changesRef.current) ? changesRef.current : undefined;
    inFlight.current = sent ?? null;
    return sent;
  }, []);

  const settle = useCallback(() => {
    if (!transport) return;
    const sent = inFlight.current;
    void queryClient
      // Read even when nothing was sent: the turn may have pinned a skill (the assistant's load)
      // and judged each pin. Forced: the detail pins `staleTime: Infinity`.
      .fetchQuery({ ...sessionQuery(transport, id), staleTime: 0 })
      .then((row) => {
        if (!sent) return;
        // A turn sent since carries these changes too: it stays in flight.
        if (inFlight.current === sent) inFlight.current = null;
        if (!row) return;
        const next = settleSkillChanges(changesRef.current, sent, row.skills);
        changesRef.current = next;
        setChanges(next);
      })
      .catch(() => {
        // Kept: the changes are idempotent, the next turn sends them again.
      });
  }, [queryClient, transport, id]);

  return { skills, actions, pinCited, takeChanges, settle };
}
