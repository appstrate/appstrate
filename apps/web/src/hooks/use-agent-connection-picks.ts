// SPDX-License-Identifier: Apache-2.0

/**
 * R3 — per-(agent, integration, authKey) connection picks remembered between
 * page loads. Persists in `localStorage` keyed by application id so a member
 * with memberships in multiple orgs/apps doesn't bleed picks across them.
 *
 * The picks feed two consumers:
 *   - the pre-run picker rendered by `AgentIntegrationsBlock` for any
 *     (integration, authKey) that has >1 accessible candidate (which would
 *     otherwise blow up at run-kickoff with `must_choose_connection`).
 *   - the `useRunAgent` mutation, which merges the picks into
 *     `connectionOverrides` so the resolver respects them without forcing
 *     the user through the 412 modal.
 *
 * Stale picks (connection deleted, unshared, or revoked between sessions)
 * are cleaned up at read time when the caller passes the current accessible
 * candidate-id set.
 */

import { useCallback, useMemo, useState } from "react";

type PicksByAuth = Record<string, string>;
type PicksByIntegration = Record<string, PicksByAuth>;

const STORAGE_PREFIX = "appstrate.agentConnectionPicks";

function storageKey(applicationId: string, agentPackageId: string): string {
  return `${STORAGE_PREFIX}:${applicationId}:${agentPackageId}`;
}

function read(applicationId: string, agentPackageId: string): PicksByIntegration {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(applicationId, agentPackageId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PicksByIntegration) : {};
  } catch {
    return {};
  }
}

function write(applicationId: string, agentPackageId: string, picks: PicksByIntegration): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(picks).length === 0) {
      window.localStorage.removeItem(storageKey(applicationId, agentPackageId));
      return;
    }
    window.localStorage.setItem(storageKey(applicationId, agentPackageId), JSON.stringify(picks));
  } catch {
    // ignore — quota errors are not actionable
  }
}

export interface UseAgentConnectionPicks {
  picks: PicksByIntegration;
  getPick(integrationId: string, authKey: string): string | undefined;
  setPick(integrationId: string, authKey: string, connectionId: string | null): void;
  clearAll(): void;
}

export function useAgentConnectionPicks(
  applicationId: string | null | undefined,
  agentPackageId: string | undefined,
): UseAgentConnectionPicks {
  // Storage tuple — re-deriving on every render is cheap (one localStorage
  // read per render of an open agent page is negligible). We keep an
  // in-memory mirror to drive React re-renders after setPick(), seeded
  // from localStorage and reset via state-key (NOT useEffect) when the
  // (app, agent) tuple changes — avoids set-state-in-effect cascades.
  const storageBaseline = useMemo<PicksByIntegration>(
    () => (applicationId && agentPackageId ? read(applicationId, agentPackageId) : {}),
    [applicationId, agentPackageId],
  );
  const [overrides, setOverrides] = useState<PicksByIntegration | null>(null);
  const [lastTuple, setLastTuple] = useState<string>(`${applicationId}|${agentPackageId}`);

  const tuple = `${applicationId}|${agentPackageId}`;
  if (tuple !== lastTuple) {
    // Inline reset on tuple change — runs during render, recognised by React
    // (it bails out the current render and re-runs with the new state).
    setLastTuple(tuple);
    setOverrides(null);
  }

  const picks = overrides ?? storageBaseline;

  const getPick = useCallback(
    (integrationId: string, authKey: string) => picks[integrationId]?.[authKey],
    [picks],
  );

  const setPick = useCallback(
    (integrationId: string, authKey: string, connectionId: string | null) => {
      if (!applicationId || !agentPackageId) return;
      setOverrides((prev) => {
        const base = prev ?? read(applicationId, agentPackageId);
        const next: PicksByIntegration = { ...base };
        const inner: PicksByAuth = { ...(next[integrationId] ?? {}) };
        if (connectionId === null) {
          delete inner[authKey];
        } else {
          inner[authKey] = connectionId;
        }
        if (Object.keys(inner).length === 0) {
          delete next[integrationId];
        } else {
          next[integrationId] = inner;
        }
        write(applicationId, agentPackageId, next);
        return next;
      });
    },
    [applicationId, agentPackageId],
  );

  const clearAll = useCallback(() => {
    if (!applicationId || !agentPackageId) return;
    setOverrides({});
    write(applicationId, agentPackageId, {});
  }, [applicationId, agentPackageId]);

  return { picks, getPick, setPick, clearAll };
}

/**
 * Read picks WITHOUT going through React state — used by the run button at
 * mutate-time so we don't need to lift the picks state up through every
 * consumer that wants to fire a run.
 */
export function readAgentConnectionPicks(
  applicationId: string,
  agentPackageId: string,
): PicksByIntegration {
  return read(applicationId, agentPackageId);
}

/**
 * Prune picks whose target connection id is no longer accessible (e.g. owner
 * unshared it, deleted it, or the actor lost membership). Mutates localStorage
 * in place and returns the cleaned set.
 */
export function pruneAgentConnectionPicks(
  applicationId: string,
  agentPackageId: string,
  validIdsByIntegration: Record<string, Set<string>>,
): PicksByIntegration {
  const current = read(applicationId, agentPackageId);
  const next: PicksByIntegration = {};
  for (const [integrationId, byAuth] of Object.entries(current)) {
    const validIds = validIdsByIntegration[integrationId];
    if (!validIds) continue; // integration removed from agent deps
    const innerNext: PicksByAuth = {};
    for (const [authKey, connId] of Object.entries(byAuth)) {
      if (validIds.has(connId)) innerNext[authKey] = connId;
    }
    if (Object.keys(innerNext).length > 0) next[integrationId] = innerNext;
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    write(applicationId, agentPackageId, next);
  }
  return next;
}
