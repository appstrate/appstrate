// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

/** `value`, once it has held still for `delayMs`: a search box asks once per pause, not per key. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
