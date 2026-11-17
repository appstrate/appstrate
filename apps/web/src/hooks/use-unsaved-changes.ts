// SPDX-License-Identifier: Apache-2.0

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPath, useBlocker, useLocation, type BlockerFunction } from "react-router-dom";
import { leavesEditor, type EditorPlace } from "../lib/editor-place";

export interface UnsavedBlocker {
  state: "blocked" | "unblocked";
  /** Other forms are dirty too: leaving discards them all, so "save and leave" is not offered. */
  othersDirty: boolean;
  proceed: () => void;
  reset: () => void;
}

export const EditorPlaceContext = createContext<EditorPlace>(() => "");

interface Guard {
  id: symbol;
  /** The location the form renders at (under an overlay, the page beneath it). */
  path: string;
  place: EditorPlace;
  dirty: boolean;
  /** `allowNavigation`, or a scope change the user agreed to: the draft is let go. */
  skip: boolean;
  /** Drops the draft, so a form that outlives a scope change is clean and guarded again. */
  discard: () => void;
}

/** A leave decision waiting on the user, shown by the one form it names. */
interface Ask {
  id: symbol;
  othersDirty: boolean;
  proceed: () => void;
  reset: () => void;
}

const guards = new Map<symbol, Guard>();
const dirtyGuards = () => [...guards.values()].filter((guard) => guard.dirty && !guard.skip);

let ask: Ask | null = null;
const listeners = new Set<() => void>();
function setAsk(next: Ask | null) {
  ask = next;
  for (const listener of listeners) listener();
}
const subscribeAsk = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getAsk = () => ask;

/** The form a blocked navigation would discard first, chosen when the router asks. */
let leaving: Omit<Ask, "proceed" | "reset"> | null = null;

const shouldBlock: BlockerFunction = ({ nextLocation }) => {
  const dirty = dirtyGuards();
  const to = new URL(createPath(nextLocation), window.location.origin);
  const guard = dirty.find((g) => leavesEditor(new URL(g.path, to), to, g.place));
  leaving = guard ? { id: guard.id, othersDirty: dirty.length > 1 } : null;
  return leaving !== null;
};

/**
 * The app's one router blocker (React Router allows one): a navigation that unmounts a
 * dirty form asks once for every dirty form. Mount once, inside the data router.
 */
export function UnsavedChangesGuard() {
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (blocker.state !== "blocked" || !leaving) return;
    const mine: Ask = { ...leaving, proceed: blocker.proceed, reset: blocker.reset };
    setAsk(mine);
    return () => {
      if (ask === mine) setAsk(null);
    };
  }, [blocker]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyGuards().length === 0) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  return null;
}

/** Store scope changes can unmount editors without changing the URL. Guard before mutating stores. */
export function requestScopeChange(action: () => void): void {
  const dirty = dirtyGuards();
  if (dirty.length === 0) {
    action();
    return;
  }
  setAsk({
    id: dirty[0]!.id,
    othersDirty: dirty.length > 1,
    proceed: () => {
      setAsk(null);
      // "Leave without saving" drops every draft. `skip` covers the navigation the change
      // may start before the forms re-render clean; a clean form clears it and is guarded
      // again (a form that stays mounted, such as an account preference, included).
      for (const guard of dirtyGuards()) {
        guard.skip = true;
        guard.discard();
      }
      action();
    },
    reset: () => setAsk(null),
  });
}

const noop = () => {};

export function useUnsavedChanges(
  isDirty: boolean,
  discard: () => void,
): {
  blocker: UnsavedBlocker;
  allowNavigation: (allowed?: boolean) => void;
} {
  const location = useLocation();
  const place = useContext(EditorPlaceContext);
  const [id] = useState(() => Symbol());
  const guard = useRef<Guard>({ id, path: "", place, dirty: isDirty, skip: false, discard });
  const path = createPath(location);
  useLayoutEffect(() => {
    Object.assign(guard.current, { path, place, dirty: isDirty, discard });
    if (!isDirty) guard.current.skip = false;
  }, [path, place, isDirty, discard]);
  useLayoutEffect(() => {
    if (!isDirty) return;
    guards.set(id, guard.current);
    return () => {
      guards.delete(id);
    };
  }, [id, isDirty]);
  const allowNavigation = useCallback((allowed = true) => {
    guard.current.skip = allowed;
  }, []);
  const asked = useSyncExternalStore(subscribeAsk, getAsk, getAsk);
  const mine = asked?.id === id ? asked : null;
  return {
    blocker: {
      state: mine ? "blocked" : "unblocked",
      othersDirty: mine?.othersDirty ?? false,
      proceed: mine?.proceed ?? noop,
      reset: mine?.reset ?? noop,
    },
    allowNavigation,
  };
}
