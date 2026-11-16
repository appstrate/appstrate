// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";

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
