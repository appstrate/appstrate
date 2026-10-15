// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { leavesEditor, type EditorPlace } from "../lib/editor-place";

export interface UnsavedBlocker {
  state: "blocked" | "unblocked";
  proceed: () => void;
  reset: () => void;
}

/**
 * Provided by a view whose query names the section (or file) it mounts: a
 * navigation that changes it unmounts the editor as surely as a new page.
 */
export const EditorPlaceContext = createContext<EditorPlace>(() => "");

let originals: { push: History["pushState"]; replace: History["replaceState"] } | null = null;

/** The real push/replaceState, captured before the first patch (not at import: no DOM there). */
function originalHistory() {
  originals ??= {
    push: history.pushState.bind(history),
    replace: history.replaceState.bind(history),
  };
  return originals;
}

/** A Back/Forward already moved the address to `href`. When that leaves the editor, push the left entry back (with its state) and answer the requested path; otherwise `null`. */
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

/**
 * Blocks navigation that would unmount the editor while `isDirty` (new pathname, tab hash or
 * `EditorPlaceContext` place). Works with BrowserRouter (no data router). Monkey-patches
 * `history.pushState`/`replaceState` so every SPA navigation is intercepted; removed on cleanup
 * or when `isDirty` turns false.
 */
export function useUnsavedChanges(isDirty: boolean) {
  const navigate = useNavigate();
  const location = useLocation();
  const skipRef = useRef(false);
  const [blocked, setBlocked] = useState(false);
  const pending = useRef<{ to: string; replace: boolean; state: unknown } | null>(null);
  const place = useContext(EditorPlaceContext);
  const current = `${location.pathname}${location.search}${location.hash}`;
  // The router's own state for the entry on screen (`idx`, `key`, `usr`): an
  // undone Back must restore it, or the overlays that read it lose their place.
  const entryState = useRef<unknown>(null);
  useEffect(() => {
    entryState.current = history.state;
  }, [current]);

  // Refs, so the patched pushState reads the latest values without re-patching.
  const dirtyRef = useRef(isDirty);
  const placeRef = useRef(place);

  useEffect(() => {
    dirtyRef.current = isDirty;
    skipRef.current = false;
  }, [isDirty]);
  useEffect(() => {
    placeRef.current = place;
  }, [place]);

  // Both are patched: `navigate(..., { replace: true })`, redirects and tab switches use replaceState.
  useEffect(() => {
    if (!isDirty) return;

    const patch =
      (original: typeof history.pushState, replace: boolean) =>
      (data: unknown, unused: string, url?: string | URL | null) => {
        if (skipRef.current || !dirtyRef.current || !url) {
          original(data, unused, url);
          return;
        }
        const from = new URL(window.location.href);
        const to = new URL(url.toString(), from);
        if (leavesEditor(from, to, placeRef.current)) {
          // React Router keeps its navigation state under `usr`.
          const state = (data as { usr?: unknown } | null)?.usr;
          pending.current = { to: `${to.pathname}${to.search}${to.hash}`, replace, state };
          setBlocked(true);
          return; // navigation blocked
        }
        // A modal opening or closing over the editor — let through.
        original(data, unused, url);
      };

    const { push, replace } = originalHistory();
    history.pushState = patch(push, false);
    history.replaceState = patch(replace, true);

    return () => {
      history.pushState = push;
      history.replaceState = replace;
    };
  }, [isDirty]);

  useEffect(() => {
    if (!isDirty) return;

    const handler = () => {
      if (skipRef.current) return;
      const to = undoLeavingPop(
        { path: current, state: entryState.current },
        window.location.href,
        placeRef.current,
        originalHistory().push,
      );
      if (to === null) return;
      pending.current = { to, replace: false, state: null };
      setBlocked(true);
    };

    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [isDirty, current]);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers and some Chromium versions need `returnValue` set to show the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  /**
   * Let through a navigation the editor itself is about to make (a submit's redirect). Re-arm
   * with `allowNavigation(false)` when the save fails: the flag otherwise stays open until
   * `isDirty` changes, which a failed save does not do.
   */
  const allowNavigation = useCallback((allowed = true) => {
    skipRef.current = allowed;
  }, []);

  const proceed = useCallback(() => {
    setBlocked(false);
    const target = pending.current;
    pending.current = null;
    if (target) {
      // The push happens synchronously; an editor the target keeps mounted
      // stays guarded.
      skipRef.current = true;
      navigate(target.to, { replace: target.replace, state: target.state });
      skipRef.current = false;
    }
  }, [navigate]);

  const reset = useCallback(() => {
    setBlocked(false);
    pending.current = null;
  }, []);

  const blocker: UnsavedBlocker = {
    state: blocked ? "blocked" : "unblocked",
    proceed,
    reset,
  };

  return { blocker, allowNavigation };
}
