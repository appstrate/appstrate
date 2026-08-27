// SPDX-License-Identifier: Apache-2.0

import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";

/**
 * Org/space context for queries. The headers are spec-declared params passed
 * explicitly (instead of relying on the client middleware alone) so they are
 * part of the React Query key — switching org or space refetches
 * instead of serving another scope's cached page.
 */
export function useOrgScope() {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  return {
    enabled: !!orgId && !!spaceId,
    header: {
      "X-Org-Id": orgId ?? undefined,
      "X-Space-Id": spaceId ?? undefined,
    },
  };
}

/**
 * Org-only variant for org-level resources. The header is a spec-declared
 * param passed explicitly (instead of relying on the client middleware
 * alone) so it is part of the React Query key — switching org refetches
 * instead of serving another org's cached page.
 */
export function useOrgOnlyScope() {
  const orgId = useCurrentOrgId();
  return {
    enabled: !!orgId,
    header: { "X-Org-Id": orgId ?? undefined },
  };
}
