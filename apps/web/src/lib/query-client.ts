// SPDX-License-Identifier: Apache-2.0

/**
 * The app's single React Query client, a module value rather than a local in
 * `main.tsx` because the role preview resets the cache from OUTSIDE React — the
 * store's actions and the API response middleware, which have no hooks.
 */

import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/errors";

/**
 * One retry, for a failure that could go the other way next time: a network
 * error, a 5xx, a timeout (408) or a rate limit (429). Any other 4xx is the
 * server's answer to this very request — a missing resource, a refused read, an
 * expired session — and asking again only repeats it. Exported for its test.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
    },
  },
});
