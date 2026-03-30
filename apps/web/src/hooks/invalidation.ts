import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidate all connection/provider-related query caches.
 *
 * Covers user connections, org profiles, bindings, flow details,
 * and provider status. Over-invalidation is negligible because
 * React Query's staleTime prevents unnecessary refetches.
 */
export function invalidateConnectionRelated(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["available-providers"] });
  qc.invalidateQueries({ queryKey: ["user-connections"] });
  qc.invalidateQueries({ queryKey: ["profile-connections"] });
  qc.invalidateQueries({ queryKey: ["org-profile-bindings"] });
  qc.invalidateQueries({ queryKey: ["org-connection-profiles"] });
  qc.invalidateQueries({ queryKey: ["packages", "flow"] });
  qc.invalidateQueries({ queryKey: ["flows"] });
  qc.invalidateQueries({ queryKey: ["flow-provider-profiles"] });
}
