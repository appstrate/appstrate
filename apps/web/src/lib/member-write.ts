// SPDX-License-Identifier: Apache-2.0

import type { QueryClient } from "@tanstack/react-query";
import { invalidateIntegrationQueries } from "../hooks/use-integrations";

/**
 * What an org-role change or a removal touches beyond the org: a promotion deletes the
 * explicit space roles, a removal the space seats, and a drop that ends space access
 * unshares the member's connections.
 */
export function invalidateMemberWrite(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}"] });
  void queryClient.invalidateQueries({ queryKey: ["get", "/api/spaces/{id}/members"] });
  void invalidateIntegrationQueries(queryClient);
}
