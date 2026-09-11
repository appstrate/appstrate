// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useOrgOnlyScope } from "./use-org-scope";
import { useInvalidatePackageInstallation } from "./use-library";

export type PackageShare = components["schemas"]["PackageShare"];

/** The `target` a revoke addresses: the space id, or the member's user id. */
export function shareTargetHandle(share: PackageShare): string {
  return share.target.kind === "user"
    ? (share.target.user_id ?? "")
    : (share.target.space_id ?? "");
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
 * revoking also uninstalls, and accepting installs. So the library — the
 * listing that renders both halves — is invalidated alongside the share list.
 */
function useInvalidateShares() {
  const qc = useQueryClient();
  const invalidateInstallation = useInvalidatePackageInstallation();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/packages/{scope}/{name}/shares"] });
    invalidateInstallation();
  };
}

export function useSharePackage() {
  const invalidate = useInvalidateShares();
  return $api.useMutation("post", "/api/packages/{scope}/{name}/shares", {
    onSuccess: invalidate,
  });
}

export function useRevokePackageShare() {
  const invalidate = useInvalidateShares();
  return $api.useMutation("delete", "/api/packages/{scope}/{name}/shares/{target}", {
    onSuccess: invalidate,
  });
}

/**
 * Add a shared package to one's own space — and, called again on an
 * already-installed one, re-pin it to the latest published version. One route
 * for both because they are one act: taking the version the author offers.
 */
export function useAcceptPackageShare() {
  const invalidate = useInvalidateShares();
  return $api.useMutation("post", "/api/packages/{scope}/{name}/shares/accept", {
    onSuccess: invalidate,
  });
}
