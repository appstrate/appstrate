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
      /**
       * Keeps the cache-level toast below quiet. For a mutation whose callers
       * ALL show the failure differently (a form error, an inline result, a
       * dedicated sentence), or a background write the user did not ask for.
       */
      errorHandledByCaller?: true;
    };
  }
}

/**
 * Every failed mutation is toasted here, once, through `onMutationError` (which
 * translates the refusals it knows). The one way out is the explicit
 * `meta.errorHandledByCaller`: an `onError` is NOT one, since most of them roll
 * a cache back or invalidate and report nothing.
 */
const mutationCache = new MutationCache({
  onError: (error, _variables, _context, mutation) => {
    if (!mutation.meta?.errorHandledByCaller) onMutationError(error);
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
