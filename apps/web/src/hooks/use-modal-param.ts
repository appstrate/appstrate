// SPDX-License-Identifier: Apache-2.0

/**
 * A modal's open state, kept in the URL.
 *
 * A modal has an address: support can say "open this", a reload lands on it,
 * and Back closes it. The navigation state rides along, so a modal opened
 * inside the settings overlay keeps the overlay's background instead of
 * turning it into a full page (the same trap `NavigateKeepingState` exists for).
 * Closing replaces rather than pushes, like the OAuth client editor, so Back
 * after a close does not reopen it.
 */
import { useLocation, useSearchParams } from "react-router-dom";

export function useModalParam(name: string) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const set = (next: string | null) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === null) out.delete(name);
        else out.set(name, next);
        return out;
      },
      { replace: next === null, state: location.state },
    );
  return {
    /** The parameter's value, or `null` when the modal is closed. */
    value: params.get(name),
    open: (value = "1") => set(value),
    close: () => set(null),
  };
}
