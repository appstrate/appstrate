// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { leavesEditor, type EditorPlace } from "../lib/editor-place";

export interface UnsavedBlocker {
  state: "blocked" | "unblocked";
  proceed: () => void;
  reset: () => void;
}

export const EditorPlaceContext = createContext<EditorPlace>(() => "");
type PendingNavigation = { to: string; replace: boolean; state: unknown; action?: () => void };
interface Guard {
  current: () => {
    path: string;
    state: unknown;
    place: EditorPlace;
    dirty: boolean;
    skip: boolean;
  };
  block: (pending: PendingNavigation) => void;
}
const guards = new Map<symbol, Guard>();
let approvedDestination: string | null = null;
const approvedGuards = new Set<symbol>();
/** A leave confirmation applies to one destination and one form, never a later navigation. */
export const approvals = {
  select(target: string) {
    if (approvedDestination !== target) {
      approvedGuards.clear();
      approvedDestination = target;
    }
  },
  approve(id: symbol, target: string) {
    approvals.select(target);
    approvedGuards.add(id);
  },
  has(id: symbol, target: string) {
    approvals.select(target);
    return approvedGuards.has(id);
  },
  clear() {
    approvedDestination = null;
    approvedGuards.clear();
  },
};
let installed = false;
let changingScope = false;

/** Store scope changes can unmount editors without changing the URL. Guard before mutating stores. */
export function requestScopeChange(key: string, action: () => void): void {
  for (const [id, guard] of guards) {
    const state = guard.current();
    if (state.dirty && !state.skip && !approvals.has(id, key)) {
      guard.block({
        to: key,
        replace: false,
        state: null,
        action: () => requestScopeChange(key, action),
      });
      return;
    }
  }
  changingScope = true;
  try {
    action();
  } finally {
    changingScope = false;
    approvals.clear();
  }
}

/** Undo one Back/Forward before asking whether to leave the mounted editor. */
export function undoLeavingPop(
  entry: { path: string; state: unknown },
  href: string,
  place: EditorPlace,
  push: History["pushState"],
): string | null {
  const to = new URL(href);
  if (!leavesEditor(new URL(entry.path, to), to, place)) return null;
  push(entry.state, "", entry.path);
  return `${to.pathname}${to.search}${to.hash}`;
}

/** Install before BrowserRouter: a pop must be intercepted before its listener can unmount editors. */
export function installUnsavedChangesGuard() {
  if (installed) return;
  installed = true;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const findGuard = (from: URL, to: URL) => {
    if (changingScope) return null;
    const target = `${to.pathname}${to.search}${to.hash}`;
    for (const [id, guard] of guards) {
      const current = guard.current();
      if (
        current.dirty &&
        !current.skip &&
        !approvals.has(id, target) &&
        leavesEditor(from, to, current.place)
      ) {
        return { id, guard };
      }
    }
    return null;
  };
  const patch =
    (original: History["pushState"], replacing: boolean): History["pushState"] =>
    (data, unused, url) => {
      if (url) {
        const from = new URL(window.location.href);
        const to = new URL(url.toString(), from);
        const blocked = findGuard(from, to);
        if (blocked) {
          blocked.guard.block({
            to: `${to.pathname}${to.search}${to.hash}`,
            replace: replacing,
            state: data?.usr ?? null,
          });
          return;
        }
      }
      approvals.clear();
      original(data, unused, url);
    };
  history.pushState = patch(push, false);
  history.replaceState = patch(replace, true);
  const pop = (event: PopStateEvent) => {
    const to = new URL(window.location.href);
    for (const guard of guards.values()) {
      const current = guard.current();
      const blocked = findGuard(new URL(current.path, to), to);
      if (!blocked) continue;
      const target = undoLeavingPop(
        { path: current.path, state: current.state },
        to.href,
        current.place,
        push,
      );
      if (target) {
        event.stopImmediatePropagation();
        blocked.guard.block({ to: target, replace: false, state: event.state?.usr ?? null });
      }
      return;
    }
    approvals.clear();
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (
      ![...guards.values()].some((guard) => {
        const state = guard.current();
        return state.dirty && !state.skip;
      })
    )
      return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("popstate", pop, true);
  window.addEventListener("beforeunload", unload);
}

export function useUnsavedChanges(isDirty: boolean): {
  blocker: UnsavedBlocker;
  allowNavigation: (allowed?: boolean) => void;
} {
  const navigate = useNavigate();
  const location = useLocation();
  const place = useContext(EditorPlaceContext);
  const [id] = useState(() => Symbol());
  const [blocked, setBlocked] = useState(false);
  const pending = useRef<PendingNavigation | null>(null);
  const skip = useRef(false);
  const current = useRef<{
    path: string;
    state: unknown;
    place: EditorPlace;
    dirty: boolean;
    skip: boolean;
  }>({ path: "", state: null, place, dirty: isDirty, skip: false });
  const path = `${location.pathname}${location.search}${location.hash}`;
  useLayoutEffect(() => {
    current.current = { path, state: history.state, place, dirty: isDirty, skip: skip.current };
  }, [path, place, isDirty]);
  useLayoutEffect(() => {
    if (!isDirty) {
      skip.current = false;
      return;
    }
    guards.set(id, {
      current: () => ({ ...current.current, skip: skip.current }),
      block: (target) => {
        pending.current = target;
        setBlocked(true);
      },
    });
    return () => {
      guards.delete(id);
      if (guards.size === 0) approvals.clear();
    };
  }, [id, isDirty]);
  const allowNavigation = useCallback((allowed = true) => {
    skip.current = allowed;
  }, []);
  const proceed = useCallback(() => {
    const target = pending.current;
    pending.current = null;
    setBlocked(false);
    if (!target) return;
    approvals.approve(id, target.to);
    if (target.action) target.action();
    else navigate(target.to, { replace: target.replace, state: target.state });
  }, [id, navigate]);
  const reset = useCallback(() => {
    pending.current = null;
    approvals.clear();
    setBlocked(false);
  }, []);
  return {
    blocker: { state: blocked ? "blocked" : "unblocked", proceed, reset },
    allowNavigation,
  };
}
