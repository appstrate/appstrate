// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's skills: the server's (the session detail, which the host's realtime keeps
 * fresh) with what the user changed since applied on top. Only the changes are sent, with the next
 * turn. A turn the server accepted (a 2xx) applied them in its first statement, so they leave what
 * the next turn sends the moment it ends, and stay displayed until the detail is read again; a
 * turn refused or failed without an answer keeps them for the next one (they are idempotent). A
 * change made while the turn ran always rides with the next one.
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
  layerSkillChanges,
  resetSkillChanges,
  subtractSkillChanges,
  type ConversationSkills,
  type SkillChangeBase,
} from "./chat-skills.ts";
import { sessionQuery } from "./sessions.ts";
import type { ChatTransport } from "./runtime-context.ts";
import { useLatest } from "./use-latest.ts";

/** A turn that took the changes: its own object, so two turns sending equal changes never mix. */
interface SentTurn {
  readonly sent: ChatSkillChanges;
  /** `null` until the server answers; accepted on a 2xx. */
  accepted: boolean | null;
  /** The sent ids (and `discovery`) no change has touched since: what acceptance applied for good. */
  readonly untouched: Set<string>;
}

/** What the server accepted and a re-read has not shown yet: displayed, never sent again. */
interface AppliedTurn {
  readonly applied: ChatSkillChanges;
}

/** An ended turn: whether the server accepted it, and what to do once the detail was read again. */
export interface EndedTurn {
  accepted: boolean;
  /** `read`: the detail was read again, so the server's state now shows what it applied. */
  settle: (read: boolean) => void;
}

const DISCOVERY = "discovery";

/** The ids (and `discovery`) whose side differs between two sets of changes. */
function touched(before: ChatSkillChanges, after: ChatSkillChanges): string[] {
  const ids = new Set([...before.pin, ...before.unpin, ...after.pin, ...after.unpin]);
  const side = (c: ChatSkillChanges, id: string) =>
    c.pin.includes(id) ? "pin" : c.unpin.includes(id) ? "unpin" : null;
  return [
    ...[...ids].filter((id) => side(before, id) !== side(after, id)),
    ...(before.skillDiscovery !== after.skillDiscovery ? [DISCOVERY] : []),
  ];
}

/**
 * The user's changes and the turns carrying them, outside React: the transport reads and marks them
 * at request time, between renders.
 *
 * - `pending`: what the next turn sends.
 * - an accepted turn's sent entries leave `pending` the moment it ends (a queued turn sent right
 *   then must not send them again: the server applied them, and the assistant may have re-pinned a
 *   skill the user unpinned) and stay displayed as `applied` until the detail is read again. An
 *   entry the user changed while the turn ran stays in `pending`.
 * - a refused turn, or one that failed without an answer, leaves `pending` as it is.
 */
export function createSkillChanges() {
  let pending: ChatSkillChanges = NO_SKILL_CHANGES;
  let applied: AppliedTurn[] = [];
  let turn: SentTurn | null = null;
  let view: ChatSkillChanges = NO_SKILL_CHANGES;
  const listeners = new Set<() => void>();
  /** `top` over everything applied and not read back yet. */
  const layered = (top: ChatSkillChanges) =>
    layerSkillChanges(
      applied.reduce((under, a) => layerSkillChanges(under, a.applied), NO_SKILL_CHANGES),
      top,
    );
  const publish = () => {
    view = layered(pending);
    for (const listener of listeners) listener();
  };
  /** Closes the turn: an accepted one moves what it applied for good out of `pending`. */
  const close = (closing: SentTurn) => {
    if (turn === closing) turn = null;
    if (!closing.accepted) return;
    const { sent, untouched } = closing;
    const done: ChatSkillChanges = {
      ...(sent.skillDiscovery !== undefined &&
        untouched.has(DISCOVERY) && { skillDiscovery: sent.skillDiscovery }),
      pin: sent.pin.filter((id) => untouched.has(id)),
      unpin: sent.unpin.filter((id) => untouched.has(id)),
    };
    pending = subtractSkillChanges(pending, done);
    applied = [...applied, { applied: done }];
  };
  return {
    /** What the panel shows: `pending` over what was applied and not read back yet. */
    get: () => view,
    /** What the next turn sends. */
    pending: () => pending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * Applies a change to `pending`. `inFlight` is what the server is applying or applied without a
     * read showing it yet (the turn in flight, then what accepted turns applied): a change may undo
     * it. `shown` is what the panel shows.
     */
    change: (
      apply: (
        current: ChatSkillChanges,
        inFlight: ChatSkillChanges | null,
        shown: ChatSkillChanges,
      ) => ChatSkillChanges,
    ) => {
      const inFlight = turn
        ? layered(turn.sent)
        : applied.length
          ? layered(NO_SKILL_CHANGES)
          : null;
      const next = apply(pending, inFlight, view);
      if (turn) for (const id of touched(pending, next)) turn.untouched.delete(id);
      pending = next;
      publish();
    },
    /** The changes the turn being sent carries (a copy), `undefined` when none. */
    take: (): ChatSkillChanges | undefined => {
      // A turn still open has had its answer: a new request leaves only after it.
      if (turn) close(turn);
      const sent = { ...pending, pin: [...pending.pin], unpin: [...pending.unpin] };
      turn = {
        sent,
        accepted: null,
        untouched: new Set([
          ...sent.pin,
          ...sent.unpin,
          ...(sent.skillDiscovery !== undefined ? [DISCOVERY] : []),
        ]),
      };
      publish();
      return hasSkillChanges(sent) ? sent : undefined;
    },
    /** The server answered the turn being sent: accepted on a 2xx, refused otherwise. */
    answered: (accepted: boolean) => {
      if (turn) turn.accepted = accepted;
    },
    /**
     * A turn ended. `null` when no turn was sent in this mount (a resumed one). A turn sent but not
     * answered yet is one the queue sent since: it stays open.
     */
    end: (): EndedTurn | null => {
      const ended = turn;
      if (ended && ended.accepted !== null) close(ended);
      const awaiting = applied;
      if (!ended && awaiting.length === 0) return null;
      publish();
      return {
        accepted: ended?.accepted === true || awaiting.length > 0,
        settle: (read) => {
          if (!read) return;
          applied = applied.filter((a) => !awaiting.includes(a));
          publish();
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
  /** The turn ended: read the detail again, then stop displaying what accepted turns applied. */
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
    (
      apply: (
        current: ChatSkillChanges,
        base: SkillChangeBase,
        shown: ChatSkillChanges,
      ) => ChatSkillChanges,
    ) => {
      if (!getEnabled()) return;
      store.change((current, inFlight, shown) =>
        apply(current, { stored: getStored(), inFlight }, shown),
      );
    },
    [store, getEnabled, getStored],
  );

  const skills = useMemo(() => conversationSkills(stored, changes), [stored, changes]);

  const actions = useMemo<SkillActions>(() => {
    // What the panel shows is what the user acts on.
    const pinnedBy = (base: SkillChangeBase, shown: ChatSkillChanges) =>
      conversationSkills(base.stored, shown).pinned;
    return {
      togglePin: (packageId) =>
        update((current, base, shown) =>
          changePin(current, packageId, !pinnedBy(base, shown).includes(packageId), base),
        ),
      setDiscovery: (on) => update((current, base) => changeDiscovery(current, on, base)),
      reset: () =>
        update((current, base, shown) => resetSkillChanges(current, pinnedBy(base, shown), base)),
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
    // again. `fetchQuery` shares a read the realtime signal already started, and reads a
    // conversation created in this mount, whose observer is not enabled yet (an invalidation
    // skips a disabled query). Until a read lands, what the turn applied stays displayed.
    void queryClient.fetchQuery({ ...sessionQuery(transport, id), staleTime: 0 }).then(
      (row) => ended.settle(row !== null),
      () => ended.settle(false),
    );
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
