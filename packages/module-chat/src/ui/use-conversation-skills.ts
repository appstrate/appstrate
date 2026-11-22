// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's skills: the server's (the session detail, which the host's realtime refreshes
 * whenever a turn's claim or the assistant changes them) with the user's changes on top, in two
 * layers (`SkillLayers`). Only the changes are sent, with the next turn. The server writes them
 * with the turn's claim, so the turn's answer decides their fate:
 * - a 2xx: written into the cached detail, out of the layers;
 * - a refusal (any other status): nothing was written, they ride with the next turn;
 * - no answer at all: the client cannot know whether the server applied them, and re-sending could
 *   drop a pin the assistant re-added since, so they are dropped and the detail shows the truth.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ChatSkillChanges } from "../skills.ts";
import {
  DEFAULT_STORED_SKILLS,
  NO_SKILL_CHANGES,
  NO_SKILL_LAYERS,
  changeDiscovery,
  changePin,
  citeSkill,
  conversationSkills,
  hasSkillChanges,
  mergeSkillChanges,
  resetSkillChanges,
  withAppliedChanges,
  type ConversationSkills,
  type SkillLayers,
  type StoredSkills,
} from "./chat-skills.ts";
import type { TurnAnswer } from "./chat-route.ts";
import { sessionQuery, sessionQueryKey, type SessionHistory } from "./sessions.ts";
import type { ChatTransport } from "./runtime-context.ts";
import { useLatest } from "./use-latest.ts";

/**
 * The user's changes outside React: the transport takes and settles them at request time, between
 * renders. `host.accepted` writes what an accepted turn sent into the server state BEFORE the store
 * drops it, so no render shows the change neither applied nor pending.
 */
export function createSkillChanges(host: {
  accepted: (sent: ChatSkillChanges) => void;
  unanswered: () => void;
}) {
  let layers: SkillLayers = NO_SKILL_LAYERS;
  const listeners = new Set<() => void>();
  const set = (next: SkillLayers) => {
    layers = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => layers,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    change: (apply: (local: ChatSkillChanges, inFlight: ChatSkillChanges) => ChatSkillChanges) =>
      set({ ...layers, local: apply(layers.local, layers.inFlight) }),
    /**
     * The changes the turn being sent carries, `undefined` when none. An unanswered turn's changes
     * stay with it (one request at a time makes that theoretical; merging loses nothing).
     */
    take: (): ChatSkillChanges | undefined => {
      const inFlight = mergeSkillChanges(layers.inFlight, layers.local);
      set({ inFlight, local: NO_SKILL_CHANGES });
      return hasSkillChanges(inFlight) ? inFlight : undefined;
    },
    answered: (answer: TurnAnswer) => {
      const sent = layers.inFlight;
      if (answer === "refused") {
        set({ inFlight: NO_SKILL_CHANGES, local: mergeSkillChanges(sent, layers.local) });
        return;
      }
      if (answer === "accepted") host.accepted(sent);
      set({ ...layers, inFlight: NO_SKILL_CHANGES });
      if (answer === "unanswered") host.unanswered();
    },
  };
}

/**
 * Writes what an accepted turn sent into the cached session detail; `false` when none is cached.
 * An older read still in flight is cancelled first, so it cannot land over the write.
 */
export function writeAcceptedSkills(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  sent: ChatSkillChanges,
): boolean {
  if (!queryClient.getQueryData(queryKey)) return false;
  void queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData<SessionHistory | null>(
    queryKey,
    (row) => row && { ...row, skills: withAppliedChanges(row.skills, sent) },
  );
  return true;
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
  /** The changes the turn being sent carries, `undefined` when none. */
  takeChanges: () => ChatSkillChanges | undefined;
  /** How the server answered the turn being sent. */
  answered: (answer: TurnAnswer) => void;
}

const selectSkills = (row: SessionHistory | null) => row?.skills;

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
  // A conversation created in this mount is read once a turn may have created it (no speculative
  // 404); from then on the host's realtime keeps the detail fresh.
  const [exists, setExists] = useState(persisted);
  const detail = useQuery({
    ...sessionQuery(transport, id),
    enabled: exists,
    select: selectSkills,
  });
  // Before the detail is read, the defaults with what accepted turns applied.
  const [unread, setUnread] = useState<StoredSkills>(DEFAULT_STORED_SKILLS);
  const stored = detail.data ?? unread;
  const getStored = useLatest(stored);
  const getEnabled = useLatest(enabled);
  const getTransport = useLatest(transport);

  const [store] = useState(() => {
    const detailKey = () => sessionQueryKey(getTransport()?.orgId, id);
    return createSkillChanges({
      accepted: (sent) => {
        setExists(true);
        if (hasSkillChanges(sent) && !writeAcceptedSkills(queryClient, detailKey(), sent)) {
          setUnread((prev) => withAppliedChanges(prev, sent));
        }
      },
      unanswered: () => {
        // The turn may have created the conversation and written the changes: read what it holds.
        setExists(true);
        void queryClient.invalidateQueries({ queryKey: detailKey(), exact: true });
      },
    });
  });
  const layers = useSyncExternalStore(store.subscribe, store.get, store.get);
  const update = useCallback(
    (apply: (local: ChatSkillChanges, base: StoredSkills) => ChatSkillChanges) => {
      if (!getEnabled()) return;
      store.change((local, inFlight) => apply(local, withAppliedChanges(getStored(), inFlight)));
    },
    [store, getEnabled, getStored],
  );

  const skills = useMemo(() => conversationSkills(stored, layers), [stored, layers]);

  const actions = useMemo<SkillActions>(() => {
    const pinnedOver = (local: ChatSkillChanges, base: StoredSkills) =>
      conversationSkills(base, { ...NO_SKILL_LAYERS, local }).pinned;
    return {
      togglePin: (packageId) =>
        update((local, base) =>
          changePin(local, packageId, !pinnedOver(local, base).includes(packageId), base),
        ),
      setDiscovery: (on) => update((local, base) => changeDiscovery(local, on, base)),
      reset: () => update((local, base) => resetSkillChanges(local, pinnedOver(local, base), base)),
    };
  }, [update]);

  const pinCited = useCallback(
    (ids: readonly string[]) => update((local) => ids.reduce(citeSkill, local)),
    [update],
  );

  return { skills, actions, pinCited, takeChanges: store.take, answered: store.answered };
}
