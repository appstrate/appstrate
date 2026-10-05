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
       * The mutation's callers show its failure themselves (a form error, a
       * dedicated toast), so the cache-level toast below stays quiet.
       */
      errorHandledByCaller?: true;
    };
  }
}

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

/**
 * Whether the cache reports a failed mutation. It does unless the hook declares
 * its own `onError` or hands the failure to its callers — so a mutation written
 * without either is never silent.
 */
export function reportsMutationError(options: {
  onError?: unknown;
  meta?: { errorHandledByCaller?: true };
}): boolean {
  return !options.onError && !options.meta?.errorHandledByCaller;
}

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (reportsMutationError(mutation.options)) onMutationError(error);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
    },
  },
});
