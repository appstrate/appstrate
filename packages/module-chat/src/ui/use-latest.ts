// SPDX-License-Identifier: Apache-2.0

import { useCallback, useLayoutEffect, useRef } from "react";

/** A getter of the latest `value`, for callbacks that outlive the render that made them. */
export function useLatest<T>(value: T): () => T {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return useCallback(() => ref.current, []);
}
