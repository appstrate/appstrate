// SPDX-License-Identifier: Apache-2.0

import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidate all connection-related query caches: the user-scope
 * connection list, the per-integration caches, and the agent details
 * that surface connection status. Over-invalidation is negligible because
 * React Query's staleTime prevents unnecessary refetches.
 *
 * Connection queries are scoped by the current application via X-Application-Id header
 * (sent automatically by api.ts). Cache keys don't include applicationId because
 * switching apps triggers a full query removal via useCurrentApplication.
 */
export function invalidateConnectionRelated(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["me-connections"] });
  qc.invalidateQueries({ queryKey: ["integrations"] });
  qc.invalidateQueries({ queryKey: ["me-integration-pins"] });
  qc.invalidateQueries({ queryKey: ["packages", "agent"] });
  qc.invalidateQueries({ queryKey: ["agents"] });
}
