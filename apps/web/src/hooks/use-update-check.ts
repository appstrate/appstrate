// SPDX-License-Identifier: Apache-2.0

import { $api } from "../api/client";

/**
 * Running platform version + update availability (`GET /api/version`, #694).
 *
 * The expensive part (GitHub Releases lookup) is cached server-side with an
 * hours-long TTL, so this query is cheap — but there is still no reason to
 * refetch on every focus/mount. One fetch per session + a slow background
 * refresh keeps the badge current on long-lived dashboard tabs.
 */
export function useUpdateCheck() {
  return $api.useQuery(
    "get",
    "/api/version",
    {},
    {
      staleTime: 60 * 60 * 1000, // 1 h
      refetchInterval: 6 * 60 * 60 * 1000, // pick up new releases on long-lived tabs
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
}
