// SPDX-License-Identifier: Apache-2.0

/**
 * The app's single React Query client, a module value rather than a local in
 * `main.tsx` because the role preview resets the cache from OUTSIDE React — the
 * store's actions and the API response middleware, which have no hooks.
 */

import { MutationCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/errors";
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

/**
 * A 4xx is the server's answer, not a hiccup: asking again returns the same
 * refusal after the retry delay, which is how a missing run sat behind a
 * spinner for seconds. 408 and 429 are the two that a second attempt can change.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
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
