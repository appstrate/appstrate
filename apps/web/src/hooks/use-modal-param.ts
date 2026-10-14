// SPDX-License-Identifier: Apache-2.0

/**
 * A modal's open state, kept in the URL.
 *
 * A modal has an address: support can say "open this", a reload lands on it,
 * and Back closes it. Opening pushes an entry and closing goes back over it, so
 * Back after a close does not reopen it; a modal the address opened (a pasted
 * link, a reload) has no entry of its own to go back over, so its close
 * replaces. The hash rides along: it holds the tab the modal was opened from.
 */
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

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

type ModalStep = { back: true } | { back: false; search: string; replace: boolean; state: unknown };

/**
 * The navigation that sets modal `name` to `next` (`null` closes it) from the
 * current entry. `closing` names the modal this one replaces: two never stack,
 * and one navigation does both.
 */
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
  const query = params.toString();
  const search = query ? `?${query}` : "";
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

export function useModalParam(name: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // `setSearchParams` drops the hash, and a detail page's tab lives in it
  // (`#settings`): a modal opened from a tab would close the tab under it.
  // The callbacks change only with the location, so they can ride in memoized
  // props.
  const set = useCallback(
    (next: string | null, closing?: string) => {
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
    [location, name, navigate],
  );
  const open = useCallback((value = "1", closing?: string) => set(value, closing), [set]);
  const close = useCallback(() => set(null), [set]);
  return {
    /** The parameter's value, or `null` when the modal is closed. */
    value: params.get(name),
    /** `closing` names the modal this one replaces. */
    open,
    close,
  };
}

/**
 * A modal on one object of a list, named by id (`?editModel=<id>`). `target` is
 * the object once the list has loaded; an id the list does not hold (deleted,
 * mistyped, another space) drops the parameter instead of leaving a modal on
 * nothing. Objects without an `id` say which key names them.
 */
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
