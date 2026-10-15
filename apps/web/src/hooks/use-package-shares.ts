// SPDX-License-Identifier: Apache-2.0

import { $api, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useInvalidatePaths } from "./use-invalidate-paths";
import { useOrgOnlyScope } from "./use-org-scope";
import { useInvalidatePackageActivation } from "./use-library";

export type PackageShare = components["schemas"]["PackageShare"];

/** The `target` a revoke addresses: the space id, or the member's user id. */
export function shareTargetHandle(share: PackageShare): string {
  return share.target.kind === "user" ? (share.target.userId ?? "") : (share.target.spaceId ?? "");
}

/**
 * A package's audience. Only a caller holding the type's `share` in its home
 * space may read it, which is exactly the caller the dialog is open for —
 * `enabled` keeps it from firing for anyone else (a 403 in the console).
 */
export function usePackageShares(packageId: string, enabled: boolean) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/shares",
    { params: { path: splitPackageRef(packageId), header: scope.header } },
    { enabled: enabled && scope.enabled, select: (envelope) => envelope.data },
  );
}

/**
 * Every write here changes what the RECIPIENT sees, not just the audience list:
 * a share places the package in the target space, and revoking takes both the
 * placement and its local instance away again. So the library — the listing
 * that renders both halves — is invalidated alongside the share list.
 */
function useInvalidateShares() {
  const invalidateShares = useInvalidatePaths("/api/packages/{scope}/{name}/shares");
  const invalidateActivation = useInvalidatePackageActivation();
  return () => {
    invalidateShares();
    invalidateActivation();
  };
}

export function useSharePackage() {
  const invalidate = useInvalidateShares();
  return $api.useMutation("post", "/api/packages/{scope}/{name}/shares", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
}

export function useRevokePackageShare() {
  const invalidate = useInvalidateShares();
  return $api.useMutation("delete", "/api/packages/{scope}/{name}/shares/{target}", {
    onSuccess: invalidate,
  });
}
