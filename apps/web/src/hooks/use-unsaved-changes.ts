// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { leavesEditor, type EditorPlace } from "../lib/editor-place";

export interface UnsavedBlocker {
  state: "blocked" | "unblocked";
  /** Other forms are dirty too: leaving discards them all, so "save and leave" is not offered. */
  othersDirty: boolean;
  proceed: () => void;
  reset: () => void;
}

export const EditorPlaceContext = createContext<EditorPlace>(() => "");
type PendingNavigation = {
  to: string;
  replace: boolean;
  state: unknown;
  action?: () => void;
  othersDirty?: boolean;
};
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
/** The destination the user agreed to leave for: one decision covers every dirty form. */
let approved: string | null = null;
let installed = false;
let changingScope = false;
const SCOPE_CHANGE = "\0scope-change";

const isDirty = (guard: Guard) => {
  const state = guard.current();
  return state.dirty && !state.skip;
};

/** Ask the first dirty form; it tells whether others would be discarded with it. */
function block(guard: Guard, pending: PendingNavigation) {
  guard.block({ ...pending, othersDirty: [...guards.values()].filter(isDirty).length > 1 });
}

/** Store scope changes can unmount editors without changing the URL. Guard before mutating stores. */
export function requestScopeChange(action: () => void): void {
  if (approved !== SCOPE_CHANGE) {
    const guard = [...guards.values()].find(isDirty);
    if (guard) {
      block(guard, {
        to: SCOPE_CHANGE,
        replace: false,
        state: null,
        action: () => requestScopeChange(action),
      });
      return;
    }
  }
  changingScope = true;
  try {
    action();
  } finally {
    changingScope = false;
    approved = null;
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
    if (changingScope || approved === `${to.pathname}${to.search}${to.hash}`) return null;
    for (const guard of guards.values()) {
      if (isDirty(guard) && leavesEditor(from, to, guard.current().place)) return guard;
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
          block(blocked, {
            to: `${to.pathname}${to.search}${to.hash}`,
            replace: replacing,
            state: data?.usr ?? null,
          });
          return;
        }
      }
      approved = null;
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
        block(blocked, { to: target, replace: false, state: event.state?.usr ?? null });
      }
      return;
    }
    approved = null;
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (![...guards.values()].some(isDirty)) return;
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
  const [blocked, setBlocked] = useState<PendingNavigation | null>(null);
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
        setBlocked(target);
      },
    });
    return () => {
      guards.delete(id);
      if (guards.size === 0) approved = null;
    };
  }, [id, isDirty]);
  const allowNavigation = useCallback((allowed = true) => {
    skip.current = allowed;
  }, []);
  const proceed = useCallback(() => {
    const target = pending.current;
    pending.current = null;
    setBlocked(null);
    if (!target) return;
    approved = target.to;
    if (target.action) target.action();
    else navigate(target.to, { replace: target.replace, state: target.state });
  }, [navigate]);
  const reset = useCallback(() => {
    pending.current = null;
    approved = null;
    setBlocked(null);
  }, []);
  return {
    blocker: {
      state: blocked ? "blocked" : "unblocked",
      othersDirty: blocked?.othersDirty ?? false,
      proceed,
      reset,
    },
    allowNavigation,
  };
}
