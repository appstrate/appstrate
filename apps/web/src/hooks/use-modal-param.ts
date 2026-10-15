// SPDX-License-Identifier: Apache-2.0

/**
 * A modal's open state, kept in the URL. Opening pushes an entry and closing goes back over it,
 * so Back after a close does not reopen it; a modal the address opened (pasted link, reload) has
 * no entry to go back over, so its close replaces. The hash rides along (it holds the tab).
 * Going back is a popstate landing after every same-tick navigation: a modal whose act takes the
 * user elsewhere uses `leave` instead of closing and then navigating.
 */
import { useCallback, useEffect, useState } from "react";
import {
  resolvePath,
  useLocation,
  useNavigate,
  useSearchParams,
  type Path,
  type To,
} from "react-router-dom";
import { searchOf } from "../lib/url-search";

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

/** The navigation that sets modal `name` to `next` (`null` closes it). `closing` names the modal this one replaces: two never stack. */
export function modalParamStep(
  current: { search: string; state: unknown },
  name: string,
  next: string | null,
  closing?: string,
): ModalStep {
  const opener = openedBy(current.state);
  if (next === null && opener === name) return { back: true };
  const params = new URLSearchParams(current.search);
  const handover = closing !== undefined && params.has(closing);
  const open = params.has(name) || handover;
  if (next === null) params.delete(name);
  else params.set(name, next);
  if (closing) params.delete(closing);
  const search = searchOf(params);
  if (next === null) return { back: false, search, replace: true, state: current.state };
  if (!open) return { back: false, search, replace: false, state: withOpener(current.state, name) };
  // The entry is the open modal's: replaced, and still an opening's own when it was one.
  const pushed = opener === name || (handover && opener === closing);
  return {
    back: false,
    search,
    replace: true,
    state: withOpener(current.state, pushed ? name : undefined),
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

function withoutParam(search: string, name: string): string {
  const params = new URLSearchParams(search);
  params.delete(name);
  return searchOf(params);
}

interface ModalNavigation {
  to: Path;
  replace: boolean;
  state: unknown;
}

/**
 * The navigations that leave modal `name` for `to`. The destination takes the modal's entry, so
 * Back lands on the page under it, closed; a modal the address opened has no such page, so its
 * entry is closed in place and the destination pushed. The destination never carries the modal's parameter.
 */
export function modalLeaveSteps(
  current: { pathname: string; search: string; hash: string; state: unknown },
  name: string,
  to: Path,
  state?: unknown,
): ModalNavigation[] {
  const destination = { to: { ...to, search: withoutParam(to.search, name) }, state };
  const open = new URLSearchParams(current.search).has(name);
  if (!open || openedBy(current.state) === name) return [{ ...destination, replace: true }];
  return [
    {
      to: {
        pathname: current.pathname,
        search: withoutParam(current.search, name),
        hash: current.hash,
      },
      replace: true,
      state: current.state,
    },
    { ...destination, replace: false },
  ];
}

export function useModalParam(name: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [closeGuard] = useState(closeOncePerEntry);
  useEffect(() => closeGuard.release(), [closeGuard, location.key]);
  // `setSearchParams` drops the hash, where a detail page's tab lives: navigate explicitly instead.
  const set = useCallback(
    (next: string | null, closing?: string) => {
      if (next === null && !closeGuard.take(location.key)) return;
      const step = modalParamStep(location, name, next, closing);
      if (step.back) {
        navigate(-1);
        return;
      }
      navigate(
        { pathname: location.pathname, search: step.search, hash: location.hash },
        { replace: step.replace, state: step.state },
      );
    },
    [location, closeGuard, name, navigate],
  );
  const open = useCallback((value = "1", closing?: string) => set(value, closing), [set]);
  const close = useCallback(() => set(null), [set]);
  const leave = useCallback(
    (to: To, state?: unknown) => {
      const steps = modalLeaveSteps(location, name, resolvePath(to, location.pathname), state);
      for (const step of steps) navigate(step.to, { replace: step.replace, state: step.state });
    },
    [location, name, navigate],
  );
  return {
    /** The parameter's value, or `null` when the modal is closed. */
    value: params.get(name),
    /** `closing` names the modal this one replaces. */
    open,
    close,
    /** Closes the modal by going to `to`, where its act took the user. */
    leave,
  };
}

/** A modal on one list object named by id (`?editModel=<id>`). An id the loaded list does not hold drops the parameter instead of leaving a modal on nothing. */
export function useModalTarget<T extends { id: string }>(
  name: string,
  items: readonly T[] | undefined,
): ReturnType<typeof useModalParam> & { target: T | undefined };
export function useModalTarget<T>(
  name: string,
  items: readonly T[] | undefined,
  keyOf: (item: T) => string,
): ReturnType<typeof useModalParam> & { target: T | undefined };
export function useModalTarget<T>(
  name: string,
  items: readonly T[] | undefined,
  keyOf: (item: T) => string = (item) => (item as { id: string }).id,
) {
  const param = useModalParam(name);
  const target =
    param.value === null ? undefined : items?.find((item) => keyOf(item) === param.value);
  const unknown = param.value !== null && items !== undefined && target === undefined;
  const { close } = param;
  useEffect(() => {
    if (unknown) close();
  }, [unknown, close]);
  return { ...param, target };
}
