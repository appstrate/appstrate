// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "../i18n";
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

function useRevokePackageShare() {
  return $api.useMutation("delete", "/api/packages/{scope}/{name}/shares/{target}");
}

/** Removes a package from one target (the sharer withdrawing an audience, or the recipient leaving a placement): the server drops the row, its settings, and disables its schedules there. `target` is a `shareTargetHandle`; `targetLabel` names it in the toast. */
export function useRemovePackageFromSpace() {
  const revoke = useRevokePackageShare();
  const invalidate = useInvalidateShares();
  const qc = useQueryClient();
  return {
    isPending: revoke.isPending,
    remove: (
      removal: { packageId: string; target: string; targetLabel: string },
      options?: { onSuccess?: () => void; leavesPage?: boolean },
    ) =>
      revoke.mutate(
        { params: { path: { ...splitPackageRef(removal.packageId), target: removal.target } } },
        {
          onSuccess: () => {
            toast.success(i18n.t("settings:catalogue.revoked", { space: removal.targetLabel }));
            // A caller leaving the removed package's page only marks queries stale: refetching
            // that page now would 404, and the next page refetches what it mounts.
            if (options?.leavesPage) void qc.invalidateQueries({ refetchType: "none" });
            else invalidate();
            options?.onSuccess?.();
          },
        },
      ),
  };
}
