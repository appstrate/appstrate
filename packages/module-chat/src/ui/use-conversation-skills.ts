// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's skills: the server's (the session detail, which the host's realtime keeps
 * fresh) with what the user changed since on top. Only the changes are sent, with the next turn.
 * When the server accepts a turn (a 2xx: it applied them in its first statement), what that turn
 * sent is written into the cached detail and leaves the changes, so no later turn sends it again
 * and the next read of the detail replaces the guess. A turn refused, or failed without an answer,
 * keeps them for the next one (they are idempotent). A change made while the turn ran always rides
 * with the next one.
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
  withAppliedChanges,
  type ConversationSkills,
  type SkillChangeBase,
  type StoredSkills,
} from "./chat-skills.ts";
import { sessionQuery, sessionQueryKey, type SessionHistory } from "./sessions.ts";
import type { ChatTransport } from "./runtime-context.ts";
import { useLatest } from "./use-latest.ts";

/** A recorded change: its side, and when it was made, so a turn knows what it sent. */
interface Entry<T> {
  value: T;
  seq: number;
}

/**
 * The user's changes and the turn carrying them, outside React: the transport reads and marks them
 * at request time, between renders. `accepted` receives what each turn the server accepted sent
 * (no change included: the conversation exists from then on).
 */
export function createSkillChanges(accepted: (sent: ChatSkillChanges) => void) {
  const pins = new Map<string, Entry<"pin" | "unpin">>();
  let discovery: Entry<boolean> | undefined;
  let seq = 0;
  // The turn sent and not answered yet, or answered and not ended yet.
  let turn: { sent: ChatSkillChanges; upTo: number; answered: boolean } | null = null;
  let changes: ChatSkillChanges = NO_SKILL_CHANGES;
  const listeners = new Set<() => void>();
  const publish = () => {
    const side = (wanted: "pin" | "unpin") =>
      [...pins].flatMap(([id, entry]) => (entry.value === wanted ? [id] : []));
    changes = {
      ...(discovery && { skillDiscovery: discovery.value }),
      pin: side("pin"),
      unpin: side("unpin"),
    };
    for (const listener of listeners) listener();
  };
  return {
    get: () => changes,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Applies a change; `inFlight` is what the unanswered turn sent, which a change may undo. */
    change: (
      apply: (current: ChatSkillChanges, inFlight: ChatSkillChanges | null) => ChatSkillChanges,
    ) => {
      const next = apply(changes, turn && !turn.answered ? turn.sent : null);
      // An entry whose side changes is a new act: a turn that sent the old one does not cover it.
      for (const id of pins.keys())
        if (!next.pin.includes(id) && !next.unpin.includes(id)) pins.delete(id);
      for (const [ids, value] of [
        [next.pin, "pin"],
        [next.unpin, "unpin"],
      ] as const) {
        for (const id of ids)
          if (pins.get(id)?.value !== value) pins.set(id, { value, seq: ++seq });
      }
      if (next.skillDiscovery === undefined) discovery = undefined;
      else if (discovery?.value !== next.skillDiscovery)
        discovery = { value: next.skillDiscovery, seq: ++seq };
      publish();
    },
    /** The changes the turn being sent carries, `undefined` when none. */
    take: (): ChatSkillChanges | undefined => {
      turn = { sent: changes, upTo: seq, answered: false };
      return hasSkillChanges(changes) ? changes : undefined;
    },
    /** The server answered the turn being sent: on a 2xx, what it sent is applied for good. */
    answered: (ok: boolean) => {
      if (!turn || turn.answered) return;
      turn.answered = true;
      if (!ok) return;
      const upTo = turn.upTo;
      for (const [id, entry] of pins) if (entry.seq <= upTo) pins.delete(id);
      if (discovery && discovery.seq <= upTo) discovery = undefined;
      accepted(turn.sent);
      publish();
    },
    /**
     * A turn ended: `false` when none was sent in this mount (a resumed one). A turn not answered
     * yet is one the queue sent since: it stays open.
     */
    end: (): boolean => {
      if (!turn) return false;
      if (turn.answered) turn = null;
      return true;
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
  /** The turn ended: read the detail again (its verdicts, the assistant's loads). */
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
  // Before the detail is read, the defaults with what accepted turns applied.
  const [unread, setUnread] = useState<StoredSkills>(DEFAULT_STORED_SKILLS);
  const stored = detail.data ?? unread;
  const getStored = useLatest(stored);
  const getEnabled = useLatest(enabled);
  const getTransport = useLatest(transport);

  const [store] = useState(() =>
    createSkillChanges((sent) => {
      setExists(true);
      if (!hasSkillChanges(sent)) return;
      const key = sessionQueryKey(getTransport()?.orgId, id);
      if (queryClient.getQueryData(key)) {
        queryClient.setQueryData<SessionHistory | null>(
          key,
          (row) => row && { ...row, skills: withAppliedChanges(row.skills, sent) },
        );
      } else {
        setUnread((prev) => withAppliedChanges(prev, sent));
      }
    }),
  );
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
    if (!store.end() || !transport) return;
    // The turn may have pinned a skill (the assistant's load) and judged each pin. `fetchQuery`
    // shares a read the realtime signal already started, and reads a conversation created in this
    // mount, whose observer may not be enabled yet (an invalidation skips a disabled query).
    void queryClient.fetchQuery({ ...sessionQuery(transport, id), staleTime: 0 }).catch(() => {
      // The next read (realtime, next turn) brings it.
    });
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
