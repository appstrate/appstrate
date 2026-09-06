// SPDX-License-Identifier: Apache-2.0

/**
 * The app's single React Query client, as a module value.
 *
 * It used to be a local in `main.tsx`, reachable only through
 * `useQueryClient()`. The role preview needs to drop every cached admin-shaped
 * row from outside React — the API client middleware that notices a refused
 * persona, and the store actions themselves — so the instance lives here and
 * `main.tsx` hands this one to the provider.
 */

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
