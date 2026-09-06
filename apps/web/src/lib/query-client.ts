// SPDX-License-Identifier: Apache-2.0

/**
 * The app's single React Query client, as a module value rather than a local in
 * `main.tsx`: the role preview drops every cached admin-shaped row from OUTSIDE
 * React — the store's enter/exit actions and the API middleware that notices a
 * refused persona — and neither can reach `useQueryClient()`.
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
