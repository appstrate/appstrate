// SPDX-License-Identifier: Apache-2.0

import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";

/** Org/space context for queries. Headers are passed explicitly so they are part of the React Query key (a scope switch refetches). */
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

/** Org-only variant for org-level resources; the header is in the key for the same reason. */
export function useOrgOnlyScope() {
  const orgId = useCurrentOrgId();
  return { enabled: !!orgId, header: orgOnlyHeader(orgId) };
}

/** {@link useOrgOnlyScope}'s header, for a caller outside React that must hit the same key. */
export function orgOnlyHeader(orgId: string | null) {
  return { "X-Org-Id": orgId ?? undefined };
}
