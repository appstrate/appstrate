// SPDX-License-Identifier: Apache-2.0

/**
 * A modal whose open state lives in the URL: for the few worth a link (a detail, an edit, a
 * share). Any other modal is a `useState` in the component that shows it.
 *
 * Opening pushes an entry and closing goes back over it, so Back after a close does not reopen
 * it; a modal the address opened (pasted link, reload) has no entry to go back over, so its
 * close replaces. The hash rides along (it holds the tab).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import i18n from "../i18n";
import { searchOf } from "../lib/url-search";

const NO_COMPANIONS: readonly string[] = [];

/** History state key naming the modal whose opening pushed the entry. */
const OPENED_BY = "openedModal";

function openedBy(state: unknown): unknown {
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)[OPENED_BY]
    : undefined;
}

function withOpener(state: unknown, name: string | undefined): unknown {
  const { [OPENED_BY]: _, ...rest } =
    typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  return name === undefined ? rest : { ...rest, [OPENED_BY]: name };
}

/** The state of an entry that opens modal `name` on another address: the modal's close goes back over it instead of replacing it. */
export function modalOpeningState(state: unknown, name: string): unknown {
  return withOpener(state, name);
}

type ModalStep = { back: true } | { back: false; search: string; replace: boolean; state: unknown };

/**
 * The navigation that sets modal `name` to `next` (`null` closes it) from the current entry.
 * `companions` are the parameters that qualify the modal's value (a version beside a package):
 * they go with it, whenever it closes or names another object.
 */
export function modalParamStep(
  current: { search: string; state: unknown },
  name: string,
  next: string | null,
  companions: readonly string[] = NO_COMPANIONS,
): ModalStep {
  const opener = openedBy(current.state);
  if (next === null && opener === name) return { back: true };
  const params = new URLSearchParams(current.search);
  const open = params.has(name);
  const previous = params.get(name);
  if (next === null) params.delete(name);
  else params.set(name, next);
  if (next !== previous) for (const companion of companions) params.delete(companion);
  const search = searchOf(params);
  if (next === null) return { back: false, search, replace: true, state: current.state };
  if (!open) return { back: false, search, replace: false, state: withOpener(current.state, name) };
  // The entry is the open modal's: replaced, and still an opening's own when it was one.
  return {
    back: false,
    search,
    replace: true,
    state: withOpener(current.state, opener === name ? name : undefined),
  };
}

/**
 * Lets each history entry issue one close. Going back is a popstate landing after the asking
 * render, which still reads the open entry: a second close from it would go back one entry too
 * far. `release` runs once the location moves, so a re-reached entry (Forward) closes again.
 */
export function closeOncePerEntry(): {
  take: (entryKey: string) => boolean;
  release: () => void;
} {
  let closedFrom: string | null = null;
  return {
    take: (entryKey) => {
      if (entryKey === closedFrom) return false;
      closedFrom = entryKey;
      return true;
    },
    release: () => {
      closedFrom = null;
    },
  };
}

export function useUrlModal(name: string, companions: readonly string[] = NO_COMPANIONS) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [closeGuard] = useState(closeOncePerEntry);
  useEffect(() => closeGuard.release(), [closeGuard, location.key]);
  // `setSearchParams` drops the hash, where a detail page's tab lives: navigate explicitly instead.
  const set = useCallback(
    (next: string | null) => {
      if (next === null && !closeGuard.take(location.key)) return;
      const step = modalParamStep(location, name, next, companions);
      if (step.back) {
        navigate(-1);
        return;
      }
      navigate(
        { pathname: location.pathname, search: step.search, hash: location.hash },
        { replace: step.replace, state: step.state },
      );
    },
    [location, closeGuard, name, companions, navigate],
  );
  const open = useCallback((value = "1") => set(value), [set]);
  const close = useCallback(() => set(null), [set]);
  return {
    /** The parameter's value, or `null` when the modal is closed. */
    value: params.get(name),
    open,
    close,
  };
}

interface ModalTargetOptions {
  /** Parameters that qualify the object and leave with it (see `modalParamStep`). */
  companions?: readonly string[];
}

/**
 * Where a URL modal's object stands. `closed`: no parameter; `pending`: the list
 * is loading; `found`: the list holds it; `vanished`: it held this id earlier
 * (deleted from its modal, renamed, refetched); `unknown`: it never did (deleted,
 * mistyped, out of reach).
 */
export type ModalTargetVerdict = "closed" | "pending" | "found" | "vanished" | "unknown";

/**
 * One look at a URL modal's object: its verdict, and the id to remember as the last one
 * the list held (`lastResolved`). A found id is remembered, a close forgets it, every other
 * verdict keeps the previous one: a reloading list or an unknown id says nothing new.
 */
export function modalTargetStep(
  value: string | null,
  loaded: boolean,
  found: boolean,
  lastResolved: string | null,
): { verdict: ModalTargetVerdict; lastResolved: string | null } {
  if (value === null) return { verdict: "closed", lastResolved: null };
  if (!loaded) return { verdict: "pending", lastResolved };
  if (found) return { verdict: "found", lastResolved: value };
  return { verdict: value === lastResolved ? "vanished" : "unknown", lastResolved };
}

/** One toast however many modals or effect runs report an unknown object. */
const UNKNOWN_TARGET_TOAST = "url-modal-unknown-target";

/**
 * A modal on one object of a list, named by id (`?editProxy=<id>`). `target` is
 * the object once the list has loaded; an id the list does not hold drops the
 * parameter instead of leaving a modal on nothing, with a toast when the id never
 * named a listed object (a link to a deleted, mistyped or out-of-reach object)
 * and silently when its object left the list. Objects without an `id` say which
 * key names them.
 */
export function useUrlModalTarget<T extends { id: string }>(
  name: string,
  items: readonly T[] | undefined,
  options?: ModalTargetOptions,
): ReturnType<typeof useUrlModal> & { target: T | undefined };
export function useUrlModalTarget<T>(
  name: string,
  items: readonly T[] | undefined,
  keyOf: (item: T) => string,
  options?: ModalTargetOptions,
): ReturnType<typeof useUrlModal> & { target: T | undefined };
export function useUrlModalTarget<T>(
  name: string,
  items: readonly T[] | undefined,
  keyOrOptions?: ((item: T) => string) | ModalTargetOptions,
  maybeOptions?: ModalTargetOptions,
) {
  const keyOf =
    typeof keyOrOptions === "function" ? keyOrOptions : (item: T) => (item as { id: string }).id;
  const options = typeof keyOrOptions === "function" ? maybeOptions : keyOrOptions;
  const param = useUrlModal(name, options?.companions);
  const target =
    param.value === null ? undefined : items?.find((item) => keyOf(item) === param.value);
  const { value, close } = param;
  const loaded = items !== undefined;
  const found = target !== undefined;
  const lastResolved = useRef<string | null>(null);
  useEffect(() => {
    const { verdict, lastResolved: next } = modalTargetStep(
      value,
      loaded,
      found,
      lastResolved.current,
    );
    lastResolved.current = next;
    if (verdict === "unknown") {
      toast.error(i18n.t("common:error.resourceUnavailable"), { id: UNKNOWN_TARGET_TOAST });
    }
    if (verdict === "unknown" || verdict === "vanished") close();
  }, [value, loaded, found, close]);
  return { ...param, target };
}
