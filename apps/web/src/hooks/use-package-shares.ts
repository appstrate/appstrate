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

/** A package's audience; only a holder of the type's `share` in its home space may read it, so `enabled` avoids a 403 for anyone else. */
export function usePackageShares(packageId: string, enabled: boolean) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/shares",
    { params: { path: splitPackageRef(packageId), header: scope.header } },
    { enabled: enabled && scope.enabled, select: (envelope) => envelope.data },
  );
}

/** Every write changes what the RECIPIENT sees (placement, local instance), so the library is invalidated with the share list. */
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
