// SPDX-License-Identifier: Apache-2.0

import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidate all connection/provider-related query caches.
 *
 * Covers user connections, org profiles, bindings, agent details,
 * and provider status. Over-invalidation is negligible because
 * React Query's staleTime prevents unnecessary refetches.
 *
 * Connection queries are scoped by the current application via X-App-Id header
 * (sent automatically by api.ts). Cache keys don't include applicationId because
 * switching apps triggers a full query removal via useCurrentApplication.
 */
export function invalidateConnectionRelated(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["available-providers"] });
  qc.invalidateQueries({ queryKey: ["user-connections"] });
  qc.invalidateQueries({ queryKey: ["profile-connections"] });
  qc.invalidateQueries({ queryKey: ["app-profile-bindings"] });
  qc.invalidateQueries({ queryKey: ["app-connection-profiles"] });
  qc.invalidateQueries({ queryKey: ["packages", "agent"] });
  qc.invalidateQueries({ queryKey: ["agents"] });
  qc.invalidateQueries({ queryKey: ["agent-provider-profiles"] });
}
