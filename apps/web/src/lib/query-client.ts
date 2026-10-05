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
 * What `requirePermission` and the org/space context guards answer. It is also
 * what makes the API client re-read the caller's permissions
 * (`lib/stale-authority.ts`) — and the gates that flip as a result unmount the
 * very dialog that had promised to show the failure.
 */
export function isPermissionRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === "forbidden";
}

/**
 * Every failed mutation is toasted here, once, through `onMutationError` (which
 * translates the refusals it knows). The one way out is the explicit
 * `meta.errorHandledByCaller`: an `onError` is NOT one, since most of them roll
 * a cache back or invalidate and report nothing. A permission refusal is
 * toasted even then: the caller that opted out may be gone before it can
 * render anything, and a lost right said twice beats one said by nobody.
 */
const mutationCache = new MutationCache({
  onError: (error, _variables, _context, mutation) => {
    if (!mutation.meta?.errorHandledByCaller || isPermissionRefusal(error)) {
      onMutationError(error);
    }
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
