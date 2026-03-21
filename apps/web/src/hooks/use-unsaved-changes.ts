import { useRef, useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";

export interface UnsavedBlocker {
  state: "blocked" | "unblocked";
  proceed: () => void;
  reset: () => void;
}

// Capture the real pushState once at module load, before any patching.
const originalPushState = history.pushState.bind(history);

/**
 * Blocks all in-app navigation (Link, navigate(), pushState, popstate, tab close)
 * when `isDirty` is true.  Works with BrowserRouter — no data router needed.
 *
 * Monkey-patches `history.pushState` while active so that every SPA navigation
 * is intercepted regardless of source (Link, navigate(), sidebar, logo, modals…).
 * The patch is removed on cleanup or when `isDirty` becomes false.
 */
export function useUnsavedChanges(isDirty: boolean) {
  const navigate = useNavigate();
  const location = useLocation();
  const skipRef = useRef(false);
  const [blocked, setBlocked] = useState(false);
  const pendingPath = useRef<string | null>(null);

  // Keep isDirty in a ref so the patched pushState reads the latest value
  // without needing to re-patch on every change.
  const dirtyRef = useRef(isDirty);

  // Reset the skip flag and sync dirtyRef whenever dirty state changes.
  useEffect(() => {
    dirtyRef.current = isDirty;
    skipRef.current = false;
  }, [isDirty]);

  // ── Monkey-patch history.pushState ─────────────────────────────────
  useEffect(() => {
    if (!isDirty) return;

    history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
      if (skipRef.current || !dirtyRef.current) {
        originalPushState(data, unused, url);
        return;
      }
      const target = url ? new URL(url.toString(), window.location.origin).pathname : null;
      if (target && target !== location.pathname) {
        pendingPath.current = target;
        setBlocked(true);
        return; // navigation blocked
      }
      // Same pathname (hash/search change only) — let through.
      originalPushState(data, unused, url);
    };

    return () => {
      history.pushState = originalPushState;
    };
  }, [isDirty, location.pathname]);

  // ── Intercept browser back/forward ─────────────────────────────────
  useEffect(() => {
    if (!isDirty) return;

    const handler = () => {
      if (skipRef.current) return;
      // The browser already changed the URL — push current path back to undo.
      pendingPath.current = window.location.pathname;
      originalPushState(null, "", location.pathname);
      setBlocked(true);
    };

    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [isDirty, location.pathname]);

  // ── Warn on browser tab close / refresh ────────────────────────────
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  /** Call before a navigation that should bypass the blocker (e.g. submit). */
  const allowNavigation = useCallback(() => {
    skipRef.current = true;
  }, []);

  const proceed = useCallback(() => {
    setBlocked(false);
    const path = pendingPath.current;
    pendingPath.current = null;
    if (path) {
      skipRef.current = true;
      navigate(path);
    }
  }, [navigate]);

  const reset = useCallback(() => {
    setBlocked(false);
    pendingPath.current = null;
  }, []);

  const blocker: UnsavedBlocker = {
    state: blocked ? "blocked" : "unblocked",
    proceed,
    reset,
  };

  return { blocker, allowNavigation };
}
