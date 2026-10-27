// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { invalidatePaths, type GetPath } from "../lib/query-keys";

/** {@link invalidatePaths} as the closure a mutation passes as `onSuccess`. */
export function useInvalidatePaths(...paths: GetPath[]): () => void {
  const qc = useQueryClient();
  return () => {
    void invalidatePaths(qc, paths);
  };
}
