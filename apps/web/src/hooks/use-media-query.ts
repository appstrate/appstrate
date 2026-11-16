// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";

/** Tailwind's `lg` breakpoint and wider. */
export const LG_AND_UP = "(min-width: 1024px)";

/** Live `matchMedia` match; `false` where there is no window (static markup). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
