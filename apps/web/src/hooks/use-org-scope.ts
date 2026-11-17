// SPDX-License-Identifier: Apache-2.0

import { useCurrentOrgId } from "./use-org";
import { useRowSpaceGrants } from "./use-permissions";
import { useCurrentSpaceId } from "./use-current-space";
import { ACROSS_SPACES_POLL_MS } from "../lib/across-spaces";
import { ACROSS_SPACES } from "../lib/query-keys";

/** Org/space context for queries. Headers are passed explicitly so they are part of the React Query key (a scope switch refetches). */
export function useOrgScope(targetSpaceId?: string) {
  const orgId = useCurrentOrgId();
  const workingSpaceId = useCurrentSpaceId();
  const spaceId = targetSpaceId ?? workingSpaceId;
  return {
    enabled: !!orgId && !!spaceId,
    header: {
      "X-Org-Id": orgId ?? undefined,
      "X-Space-Id": spaceId ?? undefined,
    },
  };
}

/** A read in the named space (the working one when omitted), under its own permission. */
export function useSpaceReadScope(permission: string, spaceId?: string) {
  const scope = useOrgScope(spaceId);
  const grants = useRowSpaceGrants();
  return { header: scope.header, enabled: scope.enabled && grants(spaceId, permission) };
}

/**
 * The scope of a list: the current space's, or, `spanning`, every space the reader reaches, asked
 * from an org route (`acrossOrgId`, null otherwise); `keySpace` is what its pinned key holds at the
 * space's position (`ACROSS_SPACES` when spanning). Each row of a spanning list is granted by
 * its own space server-side, so the current space's `canRead` does not gate it. The SSE stream
 * carries the current space only, so a spanning list a run moves polls (`refetchInterval`), or
 * it would never see another space's new rows.
 */
export function useListScope(spanning: boolean, canRead: boolean) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  return {
    orgId,
    keySpace: spanning ? ACROSS_SPACES : spaceId,
    acrossOrgId: spanning ? orgId : null,
    enabled: spanning ? !!orgId : canRead && !!orgId && !!spaceId,
    refetchInterval: spanning ? ACROSS_SPACES_POLL_MS : undefined,
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
