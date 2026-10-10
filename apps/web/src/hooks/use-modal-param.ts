// SPDX-License-Identifier: Apache-2.0

/**
 * A modal's open state, kept in the URL.
 *
 * A modal has an address: support can say "open this", a reload lands on it,
 * and Back closes it. The navigation state rides along, so a modal opened
 * inside the settings overlay keeps the overlay's background instead of
 * turning it into a full page (the same trap `NavigateKeepingState` exists for).
 * Closing replaces rather than pushes, like the OAuth client editor, so Back
 * after a close does not reopen it. The hash rides along too, for the same
 * reason as the state: it holds the tab the modal was opened from.
 */
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

export function useModalParam(name: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // `setSearchParams` drops the hash, and a detail page's tab lives in it
  // (`#settings`): a modal opened from a tab would close the tab under it.
  // The callbacks change only with the location, so they can ride in memoized
  // props (the agent map hands them to its nodes).
  const set = useCallback(
    (next: string | null, closing?: string) => {
      const out = new URLSearchParams(location.search);
      if (next === null) out.delete(name);
      else out.set(name, next);
      // Handing over to another modal: two never stack, and one navigation does both.
      if (closing) out.delete(closing);
      const search = out.toString();
      navigate(
        { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
        { replace: next === null, state: location.state },
      );
    },
    [location.search, location.pathname, location.hash, location.state, name, navigate],
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
