// SPDX-License-Identifier: Apache-2.0

/**
 * The app's single React Query client, a module value rather than a local in
 * `main.tsx` because the role preview resets the cache from OUTSIDE React — the
 * store's actions and the API response middleware, which have no hooks.
 */

import { MutationCache, QueryClient } from "@tanstack/react-query";
import { ApiError, isTransientError } from "../api/errors";
import { onMutationError } from "./mutation-error";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /** Every caller shows the failure differently, or it is a background write. */
      errorHandledByCaller?: true;
    };
  }
}

/** The API's generic 403. A lost permission is one: the gates it flips can unmount the caller before it reports. */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === "forbidden";
}

/** Every failed mutation is toasted; only the `meta` opts out, and not for a `forbidden` (said twice at worst). */
const mutationCache = new MutationCache({
  onError: (error, _variables, _context, mutation) => {
    if (!mutation.meta?.errorHandledByCaller || isForbidden(error)) onMutationError(error);
  },
});

/** One retry, of a transient failure only: a refusal comes back unchanged after the retry delay. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && isTransientError(error);
}

export const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
    },
  },
});
